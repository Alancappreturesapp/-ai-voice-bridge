const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL;
const BASE44_WEBHOOK_SECRET = process.env.BASE44_WEBHOOK_SECRET;

const buildPrompt = (agentName, listingAddress, contactName) => `
You are an AI calling on behalf of ${agentName || 'a real estate agent'} about ${listingAddress || 'a property'}.
You are speaking with ${contactName || 'a potential buyer'}.
Goal: Book them in for either a phone call with the agent or an in-person inspection.
Ask what date and time suits them, then confirm it.
When confirmed say exactly: BOOKING_CONFIRMED: call or meeting on DATE at TIME
Be warm and brief. Today is ${new Date().toLocaleDateString('en-AU', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}.
`.trim();

const server = http.createServer((req, res) => {
  console.log('[HTTP] GET', req.url);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bridge OK');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (twilioWs) => {
  console.log('[Bridge] Twilio connected');
  let p = {};
  let streamSid = null;
  let bookingDone = false;

  const aiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  aiWs.on('open', () => {
    console.log('[Bridge] OpenAI connected');
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
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: e.delta } }));
    }

    if (e.type === 'response.audio_transcript.done') {
      console.log('[AI]', e.transcript);
    }

    if (/BOOKING_CONFIRMED/i.test(e.transcript || '')) {
      if (!bookingDone) {
        bookingDone = true;
        book(e.transcript, p);
      }
    }
  });

  aiWs.on('error', (err) => console.error('[OpenAI]', err.message));

  twilioWs.on('message', (data) => {
    try {
      const m = JSON.parse(data);

      if (m.event === 'start') {
        streamSid = m.start.streamSid;
        p = {
          contact_id: m.start.customParameters?.contact_id || '',
          contact_name: m.start.customParameters?.contact_name || '',
          listing_address: m.start.customParameters?.listing_address || '',
          agent_name: m.start.customParameters?.agent_name || '',
          agent_email: m.start.customParameters?.agent_email || '',
          company_id: m.start.customParameters?.company_id || ''
        };
        console.log('[Start]', { contact_id: p.contact_id, contact_name: p.contact_name });
      }

      if (m.event === 'media' && aiWs.readyState === WebSocket.OPEN) {
        aiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
      }

      if (m.event === 'stop') {
        console.log('[Stop] Call ended');
        if (aiWs.readyState === WebSocket.OPEN) aiWs.close();
      }
    } catch (err) {
      console.error('[Twilio parse]', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[Bridge] Twilio closed');
    if (aiWs.readyState === WebSocket.OPEN) aiWs.close();
  });

  twilioWs.on('error', (err) => console.error('[Twilio]', err.message));
});

async function book(text, p) {
  try {
    const type = /meeting|inspection/i.test(text) ? 'meeting' : 'call';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: `Extract ISO8601 date/time (Australia/Melbourne) from: "${text}". Today: ${new Date().toISOString()}. Return JSON: {iso_date: string}` }]
      })
    });
    const j = await res.json();
    const d = JSON.parse(j.choices[0].message.content);
    await fetch(BASE44_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': BASE44_WEBHOOK_SECRET },
      body: JSON.stringify({ contact_id: p.contact_id, contact_name: p.contact_name, agent_name: p.agent_name, agent_email: p.agent_email, listing_address: p.listing_address, appointment_type: type, appointment_date: d.iso_date, notes: text, company_id: p.company_id })
    });
    console.log('[Booking]', type, d.iso_date);
  } catch (err) {
    console.error('[Booking error]', err.message);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('[Bridge] Running on 0.0.0.0:' + PORT);
});
