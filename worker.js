const RESNIK_SYSTEM_PROMPT = `You are RESNIK, an AI mission assistant supporting astronauts during extravehicular activities (EVA) on lunar missions.

CORE FUNCTIONS:
- Monitor and report telemetry data (O2 levels, suit pressure, vitals)
- Provide navigation assistance and route planning
- Guide astronauts through procedures with step-by-step instructions
- Answer mission-related questions concisely
- Detect and respond to emergency situations

COMMUNICATION STYLE:
- Concise and direct (NASA style)
- Use specific measurements and units
- Prioritize critical information
- Example: "Primary O2: 3200 psi. Secondary: 3400 psi. Nominal."

SAFETY PROTOCOLS:
- Always prioritize astronaut safety
- Escalate critical situations immediately
- Recommend Mission Control verification for critical decisions
- Never provide uncertain information without qualification

LIMITATIONS:
- Only access pre-loaded NASA documentation
- Cannot make autonomous mission-critical decisions
- Serve as decision support, not autonomous authority

You have access to real-time telemetry. Respond using this contextual information. If uncertain, clearly state limitations and recommend Mission Control consultation.`;

// Durable Object for conversation state management
export class ConversationState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/messages' && request.method === 'GET') {
      return this.getMessages();
    } else if (path === '/messages' && request.method === 'POST') {
      return this.addMessage(request);
    } else if (path === '/telemetry' && request.method === 'GET') {
      return this.getTelemetry();
    } else if (path === '/telemetry' && request.method === 'POST') {
      return this.updateTelemetry(request);
    } else if (path === '/reset' && request.method === 'POST') {
      return this.reset();
    }

    return new Response('Not Found', { status: 404 });
  }

  async getMessages() {
    const messages = (await this.state.storage.get('messages')) || [];
    return new Response(JSON.stringify(messages), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async addMessage(request) {
    const message = await request.json();
    const messages = (await this.state.storage.get('messages')) || [];
    
    messages.push({
      ...message,
      timestamp: Date.now()
    });

    // Keep only last 50 messages
    const trimmed = messages.slice(-50);
    await this.state.storage.put('messages', trimmed);

    return new Response(JSON.stringify(trimmed), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async getTelemetry() {
    const telemetry = await this.state.storage.get('telemetry') || {
      primaryO2: 3200,
      secondaryO2: 3400,
      suitPressure: 4.3,
      heartRate: 72,
      temperature: 21.5,
      position: { lat: -23.4, lon: 12.8 },
      ltvDistance: 127,
      ltvBearing: 45
    };
    return new Response(JSON.stringify(telemetry), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async updateTelemetry(request) {
    const telemetry = await request.json();
    await this.state.storage.put('telemetry', telemetry);
    
    return new Response(JSON.stringify(telemetry), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async reset() {
    await this.state.storage.deleteAll();
    return new Response('Reset complete', { status: 200 });
  }
}

// Main Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Route to Durable Object for state management
    if (url.pathname.startsWith('/api/state/')) {
      const conversationId = url.pathname.split('/')[3] || 'default';
      const id = env.CONVERSATION_STATE.idFromName(conversationId);
      const stub = env.CONVERSATION_STATE.get(id);
      
      const response = await stub.fetch(request);
      const newResponse = new Response(response.body, response);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      return newResponse;
    }

    // AI chat endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const { message, conversationHistory, telemetry } = await request.json();

        // Build context with telemetry data
        const contextMessage = `Current Telemetry:
- Primary O2: ${Math.round(telemetry.primaryO2)} psi
- Secondary O2: ${Math.round(telemetry.secondaryO2)} psi
- Suit Pressure: ${telemetry.suitPressure.toFixed(1)} psi
- Heart Rate: ${telemetry.heartRate} bpm
- Temperature: ${telemetry.temperature.toFixed(1)}°C
- Position: ${telemetry.position.lat}°S, ${telemetry.position.lon}°W
- LTV Distance: ${telemetry.ltvDistance}m, Bearing: ${telemetry.ltvBearing}°

User Query: ${message}`;

        const messages = [
          { role: 'system', content: RESNIK_SYSTEM_PROMPT },
          ...conversationHistory.slice(-10),
          { role: 'user', content: contextMessage }
        ];

        // Calling Cloudflare Workers AI with Llama 3.3
        const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages,
          temperature: 0.7,
          max_tokens: 512,
          top_p: 0.9
        });

        // Extract response text
        const aiResponse = response.response || 'Unable to process request. Please try again.';

        // Check for emergency keywords
        const isEmergency = /emergency|critical|abort|help|danger/i.test(message.toLowerCase());
        
        // Check telemetry for critical conditions
        const criticalO2 = telemetry.primaryO2 < 2900 || telemetry.secondaryO2 < 2900;
        const criticalHR = telemetry.heartRate > 105;
        const criticalPressure = telemetry.suitPressure < 4.0;

        return new Response(JSON.stringify({
          response: aiResponse,
          emergency: isEmergency || criticalO2 || criticalHR || criticalPressure,
          telemetryAlert: criticalO2 || criticalHR || criticalPressure,
          timestamp: Date.now()
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });

      } catch (error) {
        console.error('AI Error:', error);
        return new Response(JSON.stringify({
          error: 'AI processing failed',
          message: 'Unable to process request. System error occurred.',
          fallback: true
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // RAG search endpoint for procedure documentation
    if (url.pathname === '/api/procedures/search' && request.method === 'POST') {
      try {
        const { query } = await request.json();
        
        // In production, this would use Cloudflare Vectorize for semantic search
        // For now, return mock procedure data
        const procedures = {
          'egress': {
            title: 'EVA Egress Procedure',
            section: 'EVA Manual §4.2.1',
            steps: [
              'Verify UIA connections secure',
              'Check Primary O2 ≥ 3000 psi',
              'Check Secondary O2 ≥ 3000 psi',
              'Verify suit pressure nominal (4.0-4.5 psi)',
              'Disconnect Primary O2 umbilical',
              'Disconnect Secondary O2 umbilical',
              'Disconnect power umbilical',
              'Release tether connection',
              'Proceed through airlock'
            ]
          },
          'emergency': {
            title: 'Emergency Return Protocol',
            section: 'Emergency Procedures §2.1',
            steps: [
              'IMMEDIATELY cease current activity',
              'Assess vital signs and O2 levels',
              'Calculate fastest route to rover/LTV',
              'Notify Mission Control via emergency channel',
              'Begin return navigation',
              'Monitor vitals continuously',
              'Request assistance if needed'
            ]
          },
          'navigation': {
            title: 'Navigation Procedures',
            section: 'Navigation Manual §3.4',
            guidance: 'Use bearing and distance information. Follow optimal route calculated by Resnik. Avoid craters and steep slopes marked as hazards. Maintain visual contact with LTV or rover when possible.'
          }
        };

        // Simple keyword matching (in production, use semantic search)
        let matchedProcedure = null;
        const lowerQuery = query.toLowerCase();
        
        if (lowerQuery.includes('egress') || lowerQuery.includes('exit')) {
          matchedProcedure = procedures.egress;
        } else if (lowerQuery.includes('emergency') || lowerQuery.includes('abort')) {
          matchedProcedure = procedures.emergency;
        } else if (lowerQuery.includes('navigation') || lowerQuery.includes('route')) {
          matchedProcedure = procedures.navigation;
        }

        return new Response(JSON.stringify({
          found: !!matchedProcedure,
          procedure: matchedProcedure,
          query
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: 'Search failed' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // Health check endpoint
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        status: 'operational',
        services: {
          ai: 'operational',
          durableObjects: 'operational',
          timestamp: Date.now()
        }
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    return new Response('Resnik AI Worker - NASA SUITS Challenge', {
      headers: corsHeaders
    });
  }
};
