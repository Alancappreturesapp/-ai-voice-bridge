const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL;
const BASE44_WEBHOOK_SECRET = process.env.BASE44_WEBHOOK_SECRET;

if (!OPENAI_API_KEY) {
  console.error('[ERROR] Missing OPENAI_API_KEY');
  process.exit(1);
}
if (!BASE44_WEBHOOK_URL) {
  console.error('[ERROR] Missing BASE44_WEBHOOK_URL');
  process.exit(1);
}
if (!BASE44_WEBHOOK_SECRET) {
  console.error('[ERROR] Missing BASE44_WEBHOOK_SECRET');
  process.exit(1);
}

console.log('[Init] Environment variables loaded');
console.log('[Init] OPENAI_API_KEY:', OPENAI_API_KEY.slice(0, 10) + '...');
console.log('[Init] BASE44_WEBHOOK_URL:', BASE44_WEBHOOK_URL);
console.log('[Init] BASE44_WEBHOOK_SECRET:', 'set');

const buildPrompt = (agentName, listingAddress, contactName) => {
  return `You are an AI calling on behalf of ${agentName || 'a real estate agent'} about ${listingAddress || 'a property'}.
Speaking with ${contactName || 'a potential buyer'}.
Goal: Book them for a phone call or inspection.
Ask what date and time works, confirm it, then say: BOOKING_CONFIRMED: [call or meeting] on [date] at [time]
Be warm and brief.
Today is ${new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
};

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('[Server] Error handling request:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (twilioWs) => {
  console.log('[Bridge] Twilio connected');
  
  let params = {};
  let streamSid = null;
  let bookingDone = false;
  let aiWs = null;
  let aiReady = false;

  // Create OpenAI connection
  const connectToOpenAI = () => {
    aiReady = false;
    console.log('[OpenAI] Connecting...');
    console.log('[OpenAI] URL: wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01');
    console.log('[OpenAI] Auth key present:', !!OPENAI_API_KEY);
    
    aiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    aiWs.on('open', () => {
      console.log('[OpenAI] ✓ Connected, initializing...');
      
      try {
        aiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: 'alloy',
            modalities: ['text', 'audio'],
            temperature: 0.7,
            instructions: buildPrompt(params.agent_name, params.listing_address, params.contact_name)
          }
        }));

        aiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Begin the call now.' }]
          }
        }));

        aiWs.send(JSON.stringify({ type: 'response.create' }));
        aiReady = true;
        console.log('[OpenAI] Ready for audio');
      } catch (err) {
        console.error('[OpenAI] Init error:', err.message);
      }
    });

    aiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        // Send audio back to Twilio
        if (event.type === 'response.audio.delta' && event.delta) {
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: event.delta }
            }));
          }
        }

        // Log transcripts
        if (event.type === 'response.audio_transcript.done') {
          console.log('[AI]', event.transcript);
        }

        // Check for booking confirmation
        const transcript = event.transcript || event.text || '';
        if (transcript && /BOOKING_CONFIRMED/i.test(transcript) && !bookingDone) {
          bookingDone = true;
          console.log('[Bridge] Booking detected:', transcript);
          book(transcript, params);
        }
      } catch (err) {
        console.error('[OpenAI Message] Parse error:', err.message);
      }
    });

    aiWs.on('error', (err) => {
      console.error('[OpenAI Error]', err.message);
      aiReady = false;
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close();
      }
    });

    aiWs.on('close', () => {
      console.log('[OpenAI Closed]');
      aiReady = false;
    });
  };

  connectToOpenAI();

  // Handle Twilio messages
  twilioWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.event === 'start') {
        streamSid = message.start.streamSid;
        const customParams = message.start.customParameters || {};
        
        params = {
          contact_id: customParams.contact_id || '',
          contact_name: customParams.contact_name || '',
          listing_address: customParams.listing_address || '',
          agent_name: customParams.agent_name || '',
          agent_email: customParams.agent_email || '',
          company_id: customParams.company_id || ''
        };
        
        console.log('[Bridge] Call started:', params.contact_name);
      }

      // Only send audio if OpenAI is ready
      if (message.event === 'media') {
        if (!aiReady) {
          console.warn('[Bridge] OpenAI not ready yet, buffering audio...');
          return;
        }
        
        if (aiWs && aiWs.readyState === WebSocket.OPEN) {
          aiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.media.payload
          }));
        }
      }

      if (message.event === 'stop') {
        console.log('[Bridge] Call ended');
        if (aiWs && aiWs.readyState === WebSocket.OPEN) {
          aiWs.close();
        }
      }
    } catch (err) {
      console.error('[Twilio Message] Parse error:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[Bridge] Twilio closed');
    if (aiWs && aiWs.readyState === WebSocket.OPEN) {
      aiWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('[Twilio] Error:', err.message);
    if (aiWs && aiWs.readyState === WebSocket.OPEN) {
      aiWs.close();
    }
  });
});

async function book(text, p) {
  try {
    const type = /meeting|inspection/i.test(text) ? 'meeting' : 'call';

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `Extract appointment date/time. Today: ${new Date().toISOString()}. Return {iso_date: "ISO8601 in Australia/Melbourne"}. Text: "${text}"`
        }]
      })
    });

    if (!gptRes.ok) throw new Error(`GPT error: ${gptRes.status}`);
    const gptData = await gptRes.json();
    const booking = JSON.parse(gptData.choices[0].message.content);

    const webhookRes = await fetch(BASE44_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': BASE44_WEBHOOK_SECRET
      },
      body: JSON.stringify({
        contact_id: p.contact_id,
        contact_name: p.contact_name,
        agent_name: p.agent_name,
        agent_email: p.agent_email,
        listing_address: p.listing_address,
        appointment_type: type,
        appointment_date: booking.iso_date,
        notes: text,
        company_id: p.company_id
      })
    });

    if (!webhookRes.ok) throw new Error(`Webhook error: ${webhookRes.status}`);
    console.log('[Book] ✓ Sent to Base44 -', type, booking.iso_date);
  } catch (err) {
    console.error('[Book] Error:', err.message);
  }
}

let isHealthy = false;

server.listen(PORT, '0.0.0.0', () => {
  isHealthy = true;
  console.log(`[Bridge] ✓ Server listening on 0.0.0.0:${PORT}`);
  console.log('[Bridge] Ready to accept connections');
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[Bridge] SIGTERM received, closing');
  server.close();
  process.exit(0);
});
