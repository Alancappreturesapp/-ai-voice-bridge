const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL;
const BASE44_WEBHOOK_SECRET = process.env.BASE44_WEBHOOK_SECRET;

function buildPrompt(agentName, listingAddress, contactName) {
  return 'You are an AI calling on behalf of ' + (agentName || 'agent') + ' about ' + (listingAddress || 'property') + '.\n' +
    'Speaking with ' + (contactName || 'buyer') + '.\n' +
    'Goal: Book phone call or inspection.\n' +
    'Ask date/time, then confirm.\n' +
    'Say: BOOKING_CONFIRMED: call or meeting on DATE at TIME\n' +
    'Be brief and warm.';
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (twilioWs) => {
  console.log('[Bridge] Twilio connected');
  let p = {};
  let streamSid = null;
  let bookingDone = false;

  const aiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  aiWs.on('open', () => {
    console.log('[Bridge] OpenAI open');
    aiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'alloy',
        modalities: ['text', 'audio'],
        instructions: buildPrompt(p.agent_name, p.listing_address, p.contact_name)
      }
    }));
  });

  aiWs.on('message', (data) => {
    const e = JSON.parse(data);
    if (e.type === 'response.audio.delta' && e.delta && twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({ event: 'media', streamSid: streamSid, media: { payload: e.delta } }));
    }
    if (e.type === 'response.audio_transcript.done') {
      console.log('[AI] ' + e.transcript);
    }
    const transcript = e.transcript || '';
    if (/BOOKING_CONFIRMED/i.test(transcript) && !bookingDone) {
      bookingDone = true;
      book(transcript, p);
    }
  });

  aiWs.on('error', (err) => console.error('[OpenAI] ' + err.message));

  twilioWs.on('message', (data) => {
    try {
      const m = JSON.parse(data);
      if (m.event === 'start') {
        streamSid = m.start.streamSid;
        const cp = m.start.customParameters || {};
        p = {
          contact_id: cp.contact_id || '',
          contact_name: cp.contact_name || '',
          listing_address: cp.listing_address || '',
          agent_name: cp.agent_name || '',
          agent_email: cp.agent_email || '',
          company_id: cp.company_id || ''
        };
        console.log('[Start] ' + p.contact_name);
      }
      if (m.event === 'media' && aiWs.readyState === WebSocket.OPEN) {
        aiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
      }
      if (m.event === 'stop') {
        console.log('[Stop]');
        aiWs.close();
      }
    } catch (err) {
      console.error('[Parse] ' + err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[Twilio] closed');
    aiWs.close();
  });

  twilioWs.on('error', (err) => console.error('[Twilio] ' + err.message));
});

function book(text, p) {
  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Extract date/time from: ' + text + '. Return JSON: {iso_date: string in ISO8601}' }]
    })
  })
  .then(r => r.json())
  .then(j => {
    const d = JSON.parse(j.choices[0].message.content);
    return fetch(BASE44_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': BASE44_WEBHOOK_SECRET },
      body: JSON.stringify({ contact_id: p.contact_id, contact_name: p.contact_name, agent_name: p.agent_name, agent_email: p.agent_email, listing_address: p.listing_address, appointment_type: /meeting/i.test(text) ? 'meeting' : 'call', appointment_date: d.iso_date, notes: text, company_id: p.company_id })
    });
  })
  .catch(err => console.error('[Book] ' + err.message));
}

server.listen(PORT, '0.0.0.0', () => console.log('[Bridge] Running on 0.0.0.0:' + PORT));
