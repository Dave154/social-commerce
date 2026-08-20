


// require('dotenv').config()
// const Fastify = require('fastify')
// const { createClient } = require('@supabase/supabase-js')
// // 💡 Notice we added SchemaType here
// const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai')

// const fastify = Fastify({ logger: true })

// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" })
// const chatModel = genAI.getGenerativeModel({ model: "gemini-3.6-flash" }) 

// // ---------------------------------------------------------
// // 💡 DEFINE YOUR TOOL(S)
// // ---------------------------------------------------------
// const tools = [{
//   functionDeclarations: [{
//     name: "update_booking",
//     description: "Update the customer's active booking state. Call this tool immediately when the customer specifies or changes their vehicle, rental duration, name, or address.",
//     parameters: {
//       type: SchemaType.OBJECT,
//       properties: {
//         selected_vehicle: { type: SchemaType.STRING, description: "Name of the vehicle to rent" },
//         rental_days: { type: SchemaType.NUMBER, description: "Number of days for the rental" },
//         customer_name: { type: SchemaType.STRING, description: "The customer's name" },
//         delivery_address: { type: SchemaType.STRING, description: "The delivery address" }
//       }
//     }
//   }]
// }];

// fastify.get('/', async () => {
//   return 'Omnichannel AI Agent is Live! 🟢'
// })

// fastify.get('/webhook-test', async (request, reply) => {
//   const mode = request.query['hub.mode']
//   const token = request.query['hub.verify_token']
//   const challenge = request.query['hub.challenge']

//   if (mode && token) {
//     if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
//       console.log('🟢 Webhook verified by Meta!')
//       return reply.code(200).send(challenge) 
//     } else {
//       console.log('🔴 Webhook verification failed! Wrong password.')
//       return reply.code(403).send('Forbidden')
//     }
//   }
//   return reply.code(400).send('Bad Request')
// })

// fastify.post('/webhook-test', async (request, reply) => {
//   const body = request.body;
//   let botReply;

//   try {
//     if (body.object === 'whatsapp_business_account') {
//       const entry = body.entry?.[0];
//       const changes = entry?.changes?.[0];
//       const value = changes?.value;
//       const messageObj = value?.messages?.[0];

//       if (messageObj && messageObj.type === 'text') {
//         const customer_id = messageObj.from; 
//         const customer_message = messageObj.text.body; 
//         const vendor_id = 'a5f7f363-4ef1-4c66-bf59-27211a0d5f27'; 

//         fastify.log.info(`📥 Live WhatsApp Message from ${customer_id}: "${customer_message}"`);

//         // ---------------------------------------------------------
//         // 💡 FETCH OR CREATE LIVE BOOKING STATE
//         // ---------------------------------------------------------
//         let { data: booking } = await supabase
//           .from('bookings')
//           .select('*')
//           .eq('customer_id', customer_id)
//           .eq('status', 'in_progress')
//           .single();

//         // If they don't have an active session, open one
//         if (!booking) {
//           const { data: newBooking } = await supabase
//             .from('bookings')
//             .insert({ customer_id, vendor_id, status: 'in_progress' })
//             .select()
//             .single();
//           booking = newBooking;
//         }

//         const bookingStateText = `
//         CURRENT BOOKING STATE:
//         - Name: ${booking.customer_name || 'null'}
//         - Vehicle: ${booking.selected_vehicle || 'null'}
//         - Days: ${booking.rental_days || 'null'}
//         - Address: ${booking.delivery_address || 'null'}
//         `;

//         // ---------------------------------------------------------
//         // 1-4. MEMORY & EMBEDDINGS (Kept your logic here)
//         // ---------------------------------------------------------
//         const embedResult = await embeddingModel.embedContent(customer_message)
//         const userVector = embedResult.embedding.values

//         const { data: shortTermHistory } = await supabase
//           .from('chat_history').select('role, content')
//           .eq('vendor_id', vendor_id).eq('customer_id', customer_id)
//           .order('created_at', { ascending: false }).limit(3)

//         const recentChatText = shortTermHistory && shortTermHistory.length > 0
//           ? shortTermHistory.reverse().map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n')
//           : "No recent conversation."

//         const { data: longTermHistory } = await supabase.rpc('match_chat_history', {
//           query_embedding: userVector, match_threshold: 0.5, match_count: 10, p_vendor_id: vendor_id, p_customer_id: customer_id
//         })

//         const pastContextText = longTermHistory && longTermHistory.length > 0
//           ? longTermHistory.map(msg => `- ${msg.content}`).join('\n') : "No relevant past context."

//         const { data: products } = await supabase
//           .from('products').select('product_name, price, currency, description')
//           .eq('vendor_id', vendor_id).limit(20)
        
//         const catalogString = products ? products.map(p => `- ${p.product_name}: ${p.price || 'N/A'} ${p.currency}. (${p.description})`).join('\n') : ""

//         const { data: chunks } = await supabase.rpc('match_knowledge_chunks', {
//           query_embedding: userVector, match_threshold: 0.5, match_count: 3, p_vendor_id: vendor_id
//         })
        
//         const policyString = chunks ? chunks.map(c => c.content).join('\n\n') : ""

//         // ---------------------------------------------------------
//         // 5. GENERATE THE AI RESPONSE (WITH TOOL LOGIC)
//         // ---------------------------------------------------------
//         const systemPrompt = `
//           You are a polite, helpful customer service AI.
//           Your goal is to guide the customer to fill out all missing 'null' fields in their booking state.

//           ${bookingStateText}

//           CRITICAL RULES:
//           1. Look at the CURRENT BOOKING STATE. If a field is null, ask ONE simple question to get that info.
//           2. If the user provides any booking info (e.g., "I want the Camry"), DO NOT just reply. You MUST use the update_booking tool to save it.
          
//           === CATALOG & POLICIES ===
//           ${catalogString}
//           ${policyString}

//           === MEMORY ===
//           ${pastContextText}
//           ${recentChatText}
//         `;

//         // Package the request with our tool array
//         const requestPayload = {
//           contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER: ${customer_message}` }] }],
//           tools: tools
//         };

//         const aiResponse = await chatModel.generateContent(requestPayload);
        
//         // 💡 CHECK IF THE AI FIRED THE TOOL
//         const functionCall = aiResponse.response.functionCalls()?.[0];

//         if (functionCall && functionCall.name === 'update_booking') {
//           const args = functionCall.args;
//           fastify.log.info(`🛠️ AI Fired Tool: Updating booking for ${customer_id}`, args);

//           // Update Supabase Booking Row
//           await supabase.from('bookings')
//             .update({
//               customer_name: args.customer_name || booking.customer_name,
//               selected_vehicle: args.selected_vehicle || booking.selected_vehicle,
//               rental_days: args.rental_days || booking.rental_days,
//               delivery_address: args.delivery_address || booking.delivery_address
//             })
//             .eq('id', booking.id);

//             const modelParts = aiResponse.response.candidates[0].content.parts;

//          const followUp = await chatModel.generateContent({
//   contents: [
//     { role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER: ${customer_message}` }] },
//     { role: 'model', parts: modelParts },
//     { role: 'user', parts: [{ 
//         functionResponse: { 
//           name: functionCall.name, 
//           response: { status: 'success' },
//           id: functionCall.id
//         } 
//     }] } 
//   ],
//   tools: tools
// });
//           botReply = followUp.response.text();
//         } else {
//           // If no tool was called, just read the standard text reply
//           botReply = aiResponse.response.text();
//         }

//         // Embed and Save User/AI chat history
//         await supabase.from('chat_history').insert({
//           vendor_id, customer_id, role: 'user', content: customer_message, embedding: userVector
//         })
//         const botEmbedResult = await embeddingModel.embedContent(botReply)
//         await supabase.from('chat_history').insert({
//           vendor_id, customer_id, role: 'assistant', content: botReply, embedding: botEmbedResult.embedding.values
//         })

//         // Send to Meta
//         const metaUrl = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
//         await fetch(metaUrl, {
//           method: 'POST',
//           headers: {
//             'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
//             'Content-Type': 'application/json'
//           },
//           body: JSON.stringify({
//             messaging_product: "whatsapp",
//             to: customer_id,
//             text: { body: botReply }
//           })
//         });

//         console.log(`📤 Reply successfully sent to ${customer_id} on WhatsApp!`);
//       }
//     }

//     if (!botReply) {
//       return reply.send({ status: "ignored" })
//     }

//     return reply.send({ status: "success", bot_reply: botReply })

//   } catch (error) {
//     fastify.log.error(error)
//     return reply.status(500).send({ error: error.message })
//   }
// })

// fastify.listen({ port: 3000 }, (err, address) => {
//   if (err) process.exit(1)
//   console.log(`🚀 Server listening with State Machine on ${address}`)
// })









// require('dotenv').config()
// const Fastify = require('fastify')
// const { createClient } = require('@supabase/supabase-js')
// const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai')

// const fastify = Fastify({ logger: true })

// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" })
// const chatModel = genAI.getGenerativeModel({ model: "gemini-3.6-flash" }) 

// // ---------------------------------------------------------
// // 💡 1. UPDATED TOOL SCHEMA (Added product_id)
// // ---------------------------------------------------------
// const tools = [{
//   functionDeclarations: [{
//     name: "update_booking",
//     description: "Update the customer's active booking state. Call this tool immediately when the customer specifies or changes their vehicle, rental duration, name, or address.",
//     parameters: {
//       type: SchemaType.OBJECT,
//       properties: {
//         product_id: { type: SchemaType.STRING, description: "The exact database ID of the product category that matches the user's requested vehicle. Leave null if ambiguous." },
//         selected_vehicle: { type: SchemaType.STRING, description: "The literal name of the vehicle the user requested (e.g., 'Toyota Highlander')" },
//         rental_days: { type: SchemaType.NUMBER, description: "Number of days for the rental" },
//         customer_name: { type: SchemaType.STRING, description: "The customer's name" },
//         delivery_address: { type: SchemaType.STRING, description: "The delivery address" }
//       }
//     }
//   }]
// }];

// fastify.get('/', async () => {
//   return 'Omnichannel AI Agent is Live! 🟢'
// })

// fastify.get('/webhook-test', async (request, reply) => {
//   const mode = request.query['hub.mode']
//   const token = request.query['hub.verify_token']
//   const challenge = request.query['hub.challenge']

//   if (mode && token) {
//     if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
//       console.log('🟢 Webhook verified by Meta!')
//       return reply.code(200).send(challenge) 
//     } else {
//       console.log('🔴 Webhook verification failed! Wrong password.')
//       return reply.code(403).send('Forbidden')
//     }
//   }
//   return reply.code(400).send('Bad Request')
// })

// fastify.post('/webhook-test', async (request, reply) => {
//   const body = request.body;
//   let botReply;

//   try {
//     if (body.object === 'whatsapp_business_account') {
//       const entry = body.entry?.[0];
//       const changes = entry?.changes?.[0];
//       const value = changes?.value;
//       const messageObj = value?.messages?.[0];

//       if (messageObj && messageObj.type === 'text') {
//         const customer_id = messageObj.from; 
//         const customer_message = messageObj.text.body; 
//         const vendor_id = 'a5f7f363-4ef1-4c66-bf59-27211a0d5f27'; 

//         fastify.log.info(`📥 Live WhatsApp Message from ${customer_id}: "${customer_message}"`);

//         let { data: booking } = await supabase
//           .from('bookings')
//           .select('*')
//           .eq('customer_id', customer_id)
//           .eq('status', 'in_progress')
//           .single();

//         if (!booking) {
//           const { data: newBooking } = await supabase
//             .from('bookings')
//             .insert({ customer_id, vendor_id, status: 'in_progress' })
//             .select()
//             .single();
//           booking = newBooking;
//         }

//         const bookingStateText = `
//         CURRENT BOOKING STATE:
//         - Name: ${booking.customer_name || 'null'}
//         - Vehicle: ${booking.selected_vehicle || 'null'}
//         - Product ID: ${booking.product_id || 'null'}
//         - Days: ${booking.rental_days || 'null'}
//         - Address: ${booking.delivery_address || 'null'}
//         `;

//         const embedResult = await embeddingModel.embedContent(customer_message)
//         const userVector = embedResult.embedding.values

//         const { data: shortTermHistory } = await supabase
//           .from('chat_history').select('role, content')
//           .eq('vendor_id', vendor_id).eq('customer_id', customer_id)
//           .order('created_at', { ascending: false }).limit(3)

//         const recentChatText = shortTermHistory && shortTermHistory.length > 0
//           ? shortTermHistory.reverse().map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n')
//           : "No recent conversation."

//         const { data: longTermHistory } = await supabase.rpc('match_chat_history', {
//           query_embedding: userVector, match_threshold: 0.5, match_count: 10, p_vendor_id: vendor_id, p_customer_id: customer_id
//         })

//         const pastContextText = longTermHistory && longTermHistory.length > 0
//           ? longTermHistory.map(msg => `- ${msg.content}`).join('\n') : "No relevant past context."

//         // ---------------------------------------------------------
//         // 💡 2. INJECT DB IDs INTO CATALOG
//         // ---------------------------------------------------------
//         const { data: products } = await supabase
//           .from('products').select('id, product_name, price, currency, description')
//           .eq('vendor_id', vendor_id).limit(20)
        
//         const catalogString = products ? products.map(p => `- ID: [${p.id}] | Name: ${p.product_name} | Price: ${p.price || 'N/A'} ${p.currency} | Desc: ${p.description}`).join('\n') : ""

//         const { data: chunks } = await supabase.rpc('match_knowledge_chunks', {
//           query_embedding: userVector, match_threshold: 0.5, match_count: 3, p_vendor_id: vendor_id
//         })
        
//         const policyString = chunks ? chunks.map(c => c.content).join('\n\n') : ""

//         // ---------------------------------------------------------
//         // 💡 3. THE AMBIGUITY PROMPT
//         // ---------------------------------------------------------
//         const systemPrompt = `
//           You are a polite, helpful customer service AI for a vehicle rental business.
//           Your goal is to guide the customer to fill out all missing 'null' fields in their booking state.

//           ${bookingStateText}

//           CRITICAL RULES:
//           1. Look at the CURRENT BOOKING STATE. If a field is null, ask ONE simple question to get that info.
//           2. If the user provides any booking info, DO NOT just reply. You MUST use the update_booking tool to save it.
//           3. AMBIGUITY RULE: If a user requests a vehicle (e.g., Highlander) that exists in MULTIPLE product categories (e.g., SUV Daily and SUV Weekly), do NOT guess the product_id. Instead, ask the user a single clarifying question to determine which category fits their needs (e.g., 'Are you looking to rent this by the day or by the week?'). Only update the product_id once you have enough information to make a definitive match.
          
//           === CATALOG ===
//           ${catalogString}

//           === POLICIES ===
//           ${policyString}

//           === MEMORY ===
//           ${pastContextText}
//           ${recentChatText}
//         `;

//         const requestPayload = {
//           contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER: ${customer_message}` }] }],
//           tools: tools
//         };

//         const aiResponse = await chatModel.generateContent(requestPayload);
//         const functionCall = aiResponse.response.functionCalls()?.[0];

//         if (functionCall && functionCall.name === 'update_booking') {
//           const args = functionCall.args;
//           fastify.log.info(`🛠️ AI Fired Tool: Updating booking for ${customer_id}`, args);

//           // 💡 Update Supabase with the new product_id
//           await supabase.from('bookings')
//             .update({
//               customer_name: args.customer_name || booking.customer_name,
//               selected_vehicle: args.selected_vehicle || booking.selected_vehicle,
//               product_id: args.product_id || booking.product_id,
//               rental_days: args.rental_days || booking.rental_days,
//               delivery_address: args.delivery_address || booking.delivery_address
//             })
//             .eq('id', booking.id);

//           const modelParts = aiResponse.response.candidates[0].content.parts;

//           const followUp = await chatModel.generateContent({
//             contents: [
//               { role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER: ${customer_message}` }] },
//               { role: 'model', parts: modelParts }, 
//               { role: 'user', parts: [{ 
//                   functionResponse: { 
//                     name: functionCall.name, 
//                     response: { status: 'success' },
//                     id: functionCall.id 
//                   } 
//               }] } 
//             ],
//             tools: tools
//           });

//           botReply = followUp.response.text();
//         } else {
//           botReply = aiResponse.response.text();
//         }

//         await supabase.from('chat_history').insert({
//           vendor_id, customer_id, role: 'user', content: customer_message, embedding: userVector
//         })
//         const botEmbedResult = await embeddingModel.embedContent(botReply)
//         await supabase.from('chat_history').insert({
//           vendor_id, customer_id, role: 'assistant', content: botReply, embedding: botEmbedResult.embedding.values
//         })

//         const metaUrl = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
//         await fetch(metaUrl, {
//           method: 'POST',
//           headers: {
//             'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
//             'Content-Type': 'application/json'
//           },
//           body: JSON.stringify({
//             messaging_product: "whatsapp",
//             to: customer_id,
//             text: { body: botReply }
//           })
//         });

//         console.log(`📤 Reply successfully sent to ${customer_id} on WhatsApp!`);
//       }
//     }

//     if (!botReply) {
//       return reply.send({ status: "ignored" })
//     }

//     return reply.send({ status: "success", bot_reply: botReply })

//   } catch (error) {
//     fastify.log.error(error)
//     return reply.status(500).send({ error: error.message })
//   }
// })

// fastify.listen({ port: 3000 }, (err, address) => {
//   if (err) process.exit(1)
//   console.log(`🚀 Server listening with Fuzzy Matcher on ${address}`)
// })







require('dotenv').config()
const Fastify = require('fastify')
const { createClient } = require('@supabase/supabase-js')
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai')

const fastify = Fastify({ logger: true })

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" })
const chatModel = genAI.getGenerativeModel({ model: "gemini-3.6-flash" }) 

// ---------------------------------------------------------
// 💡 1. UPDATED TOOL SCHEMA (Added generate_checkout)
// ---------------------------------------------------------
const tools = [{
  functionDeclarations: [
    {
      name: "update_booking",
      description: "Update the customer's active booking state. Call this tool immediately when the customer specifies or changes their vehicle, rental duration, name, or address.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          product_id: { type: SchemaType.STRING, description: "The exact database ID of the product category that matches the user's requested vehicle. Leave null if ambiguous." },
          selected_vehicle: { type: SchemaType.STRING, description: "The literal name of the vehicle the user requested (e.g., 'Toyota Highlander')" },
          rental_days: { type: SchemaType.NUMBER, description: "Number of days for the rental" },
          customer_name: { type: SchemaType.STRING, description: "The customer's name" },
          delivery_address: { type: SchemaType.STRING, description: "The delivery address" }
        }
      }
    },
    {
      name: "generate_checkout",
      description: "Call this tool ONLY when the booking state has no null fields and the customer explicitly confirms they are ready to pay for their completed booking.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {} // No arguments needed, the server already knows the booking state!
      }
    }
  ]
}];

fastify.get('/', async () => {
  return 'Omnichannel AI Agent is Live! 🟢'
})


fastify.post('/paystack-webhook', async (request, reply) => {
  try {
    const crypto = require('crypto');
    
    // 1. Force-clean your secret key just like we did in the checkout tool
    const secret = process.env.PAYSTACK_SECRET_KEY.replace(/['"]/g, '').trim();
    
    // 2. Verify the Security Signature
    const hash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(request.body))
      .digest('hex');

    if (hash !== request.headers['x-paystack-signature']) {
      fastify.log.warn('🔴 Invalid Paystack Signature Detected');
      return reply.code(401).send('Unauthorized');
    }

    const event = request.body.event;
    const data = request.body.data;

    // 3. Only listen for successful charges
    if (event === 'charge.success') {
      const reference = data.reference;
      const amountPaidNaira = data.amount / 100; // Convert kobo to Naira

      fastify.log.info(`💰 Payment received! Reference: ${reference}, Amount: ₦${amountPaidNaira}`);

      // 4. Update the Database
      const { data: updatedOrder, error } = await supabase
        .from('orders')
        .update({ 
          payment_status: 'paid',
          amount_paid: amountPaidNaira 
        })
        .eq('paystack_reference', reference)
        .select('customer_phone') 
        .single();

      if (error) throw error;

      // 5. Send the Proactive WhatsApp Receipt
      if (updatedOrder && updatedOrder.customer_phone) {
        const customer_id = updatedOrder.customer_phone;
        const receiptMessage = `✅ *Payment Successful!*\n\nWe have received your payment of ₦${amountPaidNaira}. Your vehicle is officially locked in! Our delivery driver will contact you shortly.`;

        const metaUrl = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
        
        await fetch(metaUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: customer_id,
            text: { body: receiptMessage }
          })
        });
        
        console.log(`📤 Proactive Receipt sent to ${customer_id}!`);
      }
    }

    return reply.code(200).send('Webhook processed successfully');

  } catch (error) {
    fastify.log.error('Paystack Webhook Error:', error);
    return reply.code(200).send('Error but acknowledged'); 
  }
});

fastify.get('/webhook-test', async (request, reply) => {
  const mode = request.query['hub.mode']
  const token = request.query['hub.verify_token']
  const challenge = request.query['hub.challenge']

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      console.log('🟢 Webhook verified by Meta!')
      return reply.code(200).send(challenge) 
    } else {
      console.log('🔴 Webhook verification failed! Wrong password.')
      return reply.code(403).send('Forbidden')
    }
  }
  return reply.code(400).send('Bad Request')
})

fastify.post('/webhook-test', async (request, reply) => {
  const body = request.body;
  let botReply;

  try {
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messageObj = value?.messages?.[0];

      if (messageObj && messageObj.type === 'text') {
        const customer_id = messageObj.from; 
        const customer_message = messageObj.text.body; 
        const vendor_id = 'a5f7f363-4ef1-4c66-bf59-27211a0d5f27'; 

        fastify.log.info(`📥 Live WhatsApp Message from ${customer_id}: "${customer_message}"`);

        let { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('customer_id', customer_id)
          .eq('status', 'in_progress')
          .single();

        if (!booking) {
          const { data: newBooking } = await supabase
            .from('bookings')
            .insert({ customer_id, vendor_id, status: 'in_progress' })
            .select()
            .single();
          booking = newBooking;
        }

        const bookingStateText = `
        CURRENT BOOKING STATE:
        - Name: ${booking.customer_name || 'null'}
        - Vehicle: ${booking.selected_vehicle || 'null'}
        - Product ID: ${booking.product_id || 'null'}
        - Days: ${booking.rental_days || 'null'}
        - Address: ${booking.delivery_address || 'null'}
        `;

        const embedResult = await embeddingModel.embedContent(customer_message)
        const userVector = embedResult.embedding.values

        const { data: shortTermHistory } = await supabase
          .from('chat_history').select('role, content')
          .eq('vendor_id', vendor_id).eq('customer_id', customer_id)
          .order('created_at', { ascending: false }).limit(3)

        const recentChatText = shortTermHistory && shortTermHistory.length > 0
          ? shortTermHistory.reverse().map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n')
          : "No recent conversation."

        const { data: longTermHistory } = await supabase.rpc('match_chat_history', {
          query_embedding: userVector, match_threshold: 0.5, match_count: 10, p_vendor_id: vendor_id, p_customer_id: customer_id
        })

        const pastContextText = longTermHistory && longTermHistory.length > 0
          ? longTermHistory.map(msg => `- ${msg.content}`).join('\n') : "No relevant past context."

        const { data: products } = await supabase
          .from('products').select('id, product_name, price, currency, description')
          .eq('vendor_id', vendor_id).limit(20)

        const catalogString = products ? products.map(p => `- ID: [${p.id}] | Name: ${p.product_name} | Price: ${p.price || 'N/A'} ${p.currency} | Desc: ${p.description}`).join('\n') : ""

        const { data: chunks } = await supabase.rpc('match_knowledge_chunks', {
          query_embedding: userVector, match_threshold: 0.5, match_count: 3, p_vendor_id: vendor_id
        })

        const policyString = chunks ? chunks.map(c => c.content).join('\n\n') : ""

        // ---------------------------------------------------------
        // 💡 2. THE CHECKOUT PROMPT RULE ADDED
        // ---------------------------------------------------------
        const systemPrompt = `
          You are a polite, helpful customer service AI for a vehicle rental business.
          Your goal is to guide the customer to fill out all missing 'null' fields in their booking state.

          ${bookingStateText}

          CRITICAL RULES:
          1. Look at the CURRENT BOOKING STATE. If a field is null, ask ONE simple question to get that info.
          2. If the user provides any booking info, DO NOT just reply. You MUST use the update_booking tool to save it.
          3. AMBIGUITY RULE: If a user requests a vehicle (e.g., Highlander) that exists in MULTIPLE product categories (e.g., SUV Daily and SUV Weekly), do NOT guess the product_id. Instead, ask the user a single clarifying question to determine which category fits their needs.
          4. CHECKOUT RULE: When the booking state has NO null fields, ask the user to confirm if they are ready to pay. If they say yes, you MUST call the generate_checkout tool to retrieve their payment account details.

          === CATALOG ===
          ${catalogString}

          === POLICIES ===
          ${policyString}

          === MEMORY ===
          ${pastContextText}
          ${recentChatText}
        `;

        const requestPayload = {
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER: ${customer_message}` }] }],
          tools: tools
        };

        const aiResponse = await chatModel.generateContent(requestPayload);
        const functionCall = aiResponse.response.functionCalls()?.[0];

        // ---------------------------------------------------------
        // 💡 3. THE SPLIT TOOL HANDLER LOGIC
        // ---------------------------------------------------------
        if (functionCall) {
          const args = functionCall.args;
          let toolResponseData = {};

          if (functionCall.name === 'update_booking') {
            fastify.log.info(`🛠️ AI Fired Tool: Updating booking for ${customer_id}`, args);

            await supabase.from('bookings').update({
                customer_name: args.customer_name || booking.customer_name,
                selected_vehicle: args.selected_vehicle || booking.selected_vehicle,
                product_id: args.product_id || booking.product_id,
                rental_days: args.rental_days || booking.rental_days,
                delivery_address: args.delivery_address || booking.delivery_address
              }).eq('id', booking.id);
            
            toolResponseData = { status: 'success' };
          } 
          
          else if (functionCall.name === 'generate_checkout') {
            fastify.log.info(`🛠️ AI Fired Tool: Generating Checkout for ${customer_id}`);

            // Fetch the actual product price from DB
            const { data: product } = await supabase
              .from('products')
              .select('price')
              .eq('id', booking.product_id)
              .single();

            // Calculate Math (Paystack needs amounts in Kobo)
            const totalNaira = product.price * booking.rental_days;
            const totalKobo = totalNaira * 100;

            // Create the Order in your database
            const { data: newOrder } = await supabase
              .from('orders')
              .insert({ 
                customer_phone: customer_id, 
                amount_expected: totalNaira, 
                payment_status: 'pending',
                vendor_id: vendor_id,                 
                product_id: booking.product_id,      
                product_purchased: booking.selected_vehicle
              })
  .select().single();
            // Link the new order to the booking
            await supabase.from('bookings').update({ order_id: newOrder.id }).eq('id', booking.id);
           console.log(process.env.PAYSTACK_SECRET_KEY)
            // Ping Paystack for the Temporary Account
            const paystackResponse = await fetch('https://api.paystack.co/charge', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                email: `customer_${customer_id.replace(/\D/g, '')}@jkrentals.com`, 
                amount: totalKobo,
                bank_transfer: { 
                  account_expires_at: new Date(Date.now() + 30 * 60000).toISOString() 
                } 
              })
            });

            const paystackData = await paystackResponse.json();
               console.log('Paystack Response:', paystackData);
            // Extract account details and update database
            if (paystackData.status && paystackData.data.status === 'pending_bank_transfer') {
              const bankName = paystackData.data.bank.name;
              const accountNumber = paystackData.data.account_number;
              const accountName = paystackData.data.account_name;

              const reference = paystackData.data.reference;

              await supabase.from('orders').update({
                paystack_reference: reference,
                payment_bank: bankName,
                payment_account_number: accountNumber
              }).eq('id', newOrder.id);

              // Give the AI the data it needs to reply to the customer
              toolResponseData = { 
                status: 'success', 
                total_amount: `₦${totalNaira}`, 
                bank: bankName, 
                account_number: accountNumber,
                account_name: accountName,
                note: "Account expires in 30 minutes."
              };
            } else {
              toolResponseData = { status: 'error', message: 'Could not generate account right now.' };
            }
          }

          // Feed the tool execution results back to the AI
          const modelParts = aiResponse.response.candidates[0].content.parts;
          const followUp = await chatModel.generateContent({
            contents: [
              { role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER: ${customer_message}` }] },
              { role: 'model', parts: modelParts }, 
              { role: 'user', parts: [{ 
                  functionResponse: { 
                    name: functionCall.name, 
                    response: toolResponseData, 
                    id: functionCall.id 
                  } 
              }] } 
            ],
            tools: tools
          });

          botReply = followUp.response.text();
        } else {
          // Standard reply if no tool was fired
          botReply = aiResponse.response.text();
        }

        await supabase.from('chat_history').insert({
          vendor_id, customer_id, role: 'user', content: customer_message, embedding: userVector
        })
        const botEmbedResult = await embeddingModel.embedContent(botReply)
        await supabase.from('chat_history').insert({
          vendor_id, customer_id, role: 'assistant', content: botReply, embedding: botEmbedResult.embedding.values
        })

        const metaUrl = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
        await fetch(metaUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: customer_id,
            text: { body: botReply }
          })
        });

        console.log(`📤 Reply successfully sent to ${customer_id} on WhatsApp!`);
      }
    }

    if (!botReply) {
      return reply.send({ status: "ignored" })
    }

    return reply.send({ status: "success", bot_reply: botReply })

  } catch (error) {
    fastify.log.error(error)
    return reply.status(500).send({ error: error.message })
  }
})

fastify.listen({ port: 3000 }, (err, address) => {
  if (err) process.exit(1)
  console.log(`🚀 Server listening with Checkout Engine on ${address}`)
})