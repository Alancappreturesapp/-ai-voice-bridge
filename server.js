const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL;
const BASE44_WEBHOOK_SECRET = process.env.BASE44_WEBHOOK_SECRET;

const buildPrompt = (agentName, listingAddress, contactName) => [
  'You are an AI calling on behalf of ' + (agentName || 'a real estate agent') + ' about ' + (listingAddress || 'a property') + '.',
  'You are speaking with ' + (contactName || 'a potential buyer') + '.',
  'Goal: Book them in for either a phone call with the agent or an in-person inspection.',
  'Ask what date and time suits them, then confirm it.',
  'When confirmed say exactly: BOOKING_CONFIRMED: [call or meeting] on [date] at [time]',
  'Be warm and brief. Today is ' + new Date().toLocaleDateString('en-AU', {weekday:'long',year:'numeric',month:'long',day:'numeric'}) + '.',
].join('\n');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', function(twilioWs, req) {
  console.log('[Bridge] New WebSocket connection:', req.url);

  var p = {};
  var streamSid = null;
  var bookingDone = false;
  var aiReady = false;
  var paramsReady = false;

  function startSession() {
    console.log('[Bridge] Starting AI session with params:', JSON.stringify(p));
    aiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'alloy',
        modalities: ['text', 'audio'],
        temperature: 0.7,
        instructions: buildPrompt(p.agent_name, p.listing_address, p.contact_name)
      }
    }));
    aiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Begin the call now.' }] }
    }));
    aiWs.send(JSON.stringify({ type: 'response.create' }));
  }

  var aiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  aiWs.on('error', function(err) { console.error('[Bridge] OpenAI error:', err.message); });
  twilioWs.on('error', function(err) { console.error('[Bridge] Twilio error:', err.message); });

  aiWs.on('open', function() {
    console.log('[Bridge] Connected to OpenAI');
    aiReady = true;
    if (paramsReady) startSession();
  });

  aiWs.on('message', function(data) {
    var e = JSON.parse(data.toString());
    if (e.type === 'response.audio.delta' && e.delta) {
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'media', streamSid: streamSid, media: { payload: e.delta } }));
      }
    }
    var text = e.transcript || e.text || '';
    if ((e.type === 'response.audio_transcript.done' || e.type === 'response.text.done') && text.indexOf('BOOKING_CONFIRMED') !== -1 && !bookingDone) {
      bookingDone = true;
      book(text, p);
    }
  });

  twilioWs.on('message', function(data) {
    var m = JSON.parse(data.toString());
    if (m.event === 'start') {
      streamSid = m.start.streamSid;
      var cp = m.start.customParameters || {};
      p = {
        contact_id: cp.contact_id || '',
        contact_name: cp.contact_name || '',
        listing_address: cp.listing_address || '',
        agent_name: cp.agent_name || '',
        agent_email: cp.agent_email || '',
        company_id: cp.company_id || ''
      };
      console.log('[Bridge] Stream started, SID:', streamSid, 'params:', JSON.stringify(p));
      paramsReady = true;
      if (aiReady) startSession();
    }
    if (m.event === 'media' && aiWs.readyState === WebSocket.OPEN) {
      aiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
    }
    if (m.event === 'stop') {
      console.log('[Bridge] Call ended');
      aiWs.close();
    }
  });

  twilioWs.on('close', function() {
    console.log('[Bridge] Twilio WS closed');
    if (aiWs.readyState === WebSocket.OPEN) aiWs.close();
  });
});

function book(text, p) {
  var type = /meeting|inspection/i.test(text) ? 'meeting' : 'call';
  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Return JSON with iso_date (ISO8601 Australia/Melbourne) from: "' + text + '". Today: ' + new Date().toISOString() }]
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(j) {
    var d = JSON.parse(j.choices[0].message.content);
    return fetch(BASE44_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': BASE44_WEBHOOK_SECRET },
      body: JSON.stringify({
        contact_id: p.contact_id, contact_name: p.contact_name, agent_name: p.agent_name,
        agent_email: p.agent_email, listing_address: p.listing_address, appointment_type: type,
        appointment_date: d.iso_date, notes: text, company_id: p.company_id
      })
    });
  })
  .then(function() { console.log('[Bridge] Booking created:', type); })
  .catch(function(err) { console.error('[Bridge] Booking error:', err.message); });
}

server.listen(PORT, '0.0.0.0', function() {
  console.log('[Bridge] Server running on 0.0.0.0:' + PORT);
});
