require('dotenv').config()
const Fastify = require('fastify')
const { createClient } = require('@supabase/supabase-js')
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai')

const fastify = Fastify({ logger: true })

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" })
const chatModel = genAI.getGenerativeModel({ model: "gemini-3.6-flash" }) 

const TELEGRAM_QUEUE_NAME = 'telegram_messages'
const TELEGRAM_VENDOR_ID = 'a5f7f363-4ef1-4c66-bf59-27211a0d5f27'
const telegramCustomerQueues = new Map()

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
      name: "search_products",
      description: "Search the complete vehicle catalog when the customer asks what vehicles are available or asks about a vehicle, type, feature, or price. Use search_term 'all' for a general availability question.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          search_term: {
            type: SchemaType.STRING,
            description: "The vehicle name, category, feature, or price keyword to search for, or 'all' to list available vehicles."
          }
        },
        required: ['search_term']
      }
    },
    {
      name: "generate_checkout",
      description: "Call this tool ONLY when the booking state has no null fields, the customer explicitly confirms they are ready to pay, and they have chosen a payment method.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          payment_method: {
            type: SchemaType.STRING,
            enum: ['paystack_link', 'transfer'],
            description: "The customer's chosen payment method: paystack_link for a Paystack checkout link, or transfer for temporary bank account details."
          }
        },
        required: ['payment_method']
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
        .select('id, customer_phone, channel')
        .single();

      if (error) throw error;

      // Payment closes the booking session. A later message will create a new one.
      const { error: bookingError } = await supabase
        .from('bookings')
        .update({ status: 'completed' })
        .eq('order_id', updatedOrder.id);

      if (bookingError) throw bookingError;

      // 5. Send the Proactive WhatsApp Receipt
      if (updatedOrder && updatedOrder.customer_phone) {
        const isTelegramCustomer = updatedOrder.channel === 'telegram';
        const customer_id = updatedOrder.customer_phone;
        const receiptMessage = `✅ *Payment Successful!*\n\nWe have received your payment of ₦${amountPaidNaira}. Your vehicle is officially locked in! Our delivery driver will contact you shortly.`;

        await sendOutboundMessage({
          channel: updatedOrder.channel || 'whatsapp',
          customer_id,
          botReply: receiptMessage
        });
        
        console.log(`📤 Proactive Receipt sent to ${isTelegramCustomer ? 'Telegram' : 'WhatsApp'} customer ${customer_id}!`);
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

async function sendOutboundMessage({ channel, customer_id, botReply }) {
  if (channel === 'telegram') {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: customer_id, text: botReply.replace(/[\*_~`]/g, '') })
      }
    )
    if (!telegramResponse.ok) {
      throw new Error(`Telegram sendMessage failed with HTTP ${telegramResponse.status}`)
    }

    return
  }

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
}

async function sendTelegramTypingAction(customer_id) {
  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: customer_id, action: 'typing' })
    }
  )

  if (!telegramResponse.ok) {
    throw new Error(`Telegram sendChatAction failed with HTTP ${telegramResponse.status}`)
  }
}

async function enqueueTelegramMessage({ update_id, customer_id, customer_message }) {
  const { error } = await supabase
    .schema('pgmq_public')
    .rpc('send', {
      queue_name: TELEGRAM_QUEUE_NAME,
      message: {
        update_id,
        customer_id: String(customer_id),
        customer_message,
        vendor_id: TELEGRAM_VENDOR_ID,
        channel: 'telegram'
      },
      sleep_seconds: 2
    })

  if (error) throw error
}

function scheduleTelegramCustomer(customerKey) {
  const customerQueue = telegramCustomerQueues.get(customerKey)
  if (!customerQueue || customerQueue.timer) return

  customerQueue.timer = setTimeout(() => {
    customerQueue.timer = null
    processTelegramCustomer(customerKey).catch(error => {
      fastify.log.error(error, 'Telegram queue processing failed')
    })
  }, 2500)
}

async function processTelegramCustomer(customerKey) {
  const customerQueue = telegramCustomerQueues.get(customerKey)
  if (!customerQueue || customerQueue.processing) return

  const messagesToProcess = customerQueue.messages.splice(0)
  if (messagesToProcess.length === 0) return

  customerQueue.processing = true
  try {
    const firstMessage = messagesToProcess[0].message
    const combinedMessage = messagesToProcess
      .map(queueMessage => queueMessage.message.customer_message)
      .join('\n')

    await sendTelegramTypingAction(firstMessage.customer_id)
    const typingInterval = setInterval(() => {
      sendTelegramTypingAction(firstMessage.customer_id).catch(error => {
        fastify.log.warn(error, 'Telegram typing action failed')
      })
    }, 4000)

    try {
      await processIncomingMessage({
        customer_id: firstMessage.customer_id,
        customer_message: combinedMessage,
        vendor_id: firstMessage.vendor_id,
        channel: firstMessage.channel
      })

      for (const queueMessage of messagesToProcess) {
        const { error } = await supabase
          .schema('pgmq_public')
          .rpc('delete', {
            queue_name: TELEGRAM_QUEUE_NAME,
            message_id: queueMessage.msg_id
          })
        if (error) throw error
      }
    } finally {
      clearInterval(typingInterval)
    }
  } finally {
    customerQueue.processing = false
    if (customerQueue.messages.length > 0) scheduleTelegramCustomer(customerKey)
    if (!customerQueue.processing && customerQueue.messages.length === 0) {
      telegramCustomerQueues.delete(customerKey)
    }
  }
}

async function pollTelegramQueue() {
  const { data: queueMessages, error } = await supabase
    .schema('pgmq_public')
    .rpc('read', {
      queue_name: TELEGRAM_QUEUE_NAME,
      sleep_seconds: 120,
      n: 20
    })

  if (error) throw error

  for (const queueMessage of queueMessages || []) {
    const message = queueMessage.message || queueMessage.msg
    if (!message?.channel || !message?.customer_id || typeof message.customer_message !== 'string') {
      fastify.log.warn({ queueMessage }, 'Ignoring malformed Telegram queue message')
      continue
    }

    const customerKey = `${message.channel}:${message.customer_id}`
    const customerQueue = telegramCustomerQueues.get(customerKey) || {
      messages: [],
      processing: false,
      timer: null
    }
    customerQueue.messages.push({
      msg_id: queueMessage.msg_id,
      message
    })
    telegramCustomerQueues.set(customerKey, customerQueue)
    scheduleTelegramCustomer(customerKey)
  }
}

function startTelegramQueueWorker() {
  const poll = () => pollTelegramQueue().catch(error => {
    fastify.log.error(error, 'Telegram queue poll failed')
  })

  poll()
  setInterval(poll, 1000)
}

async function embedText(text) {
  const normalizedText = String(text || '').trim()
  if (!normalizedText) throw new Error('Cannot create an embedding for an empty message')

  const result = await embeddingModel.embedContent({
    content: { parts: [{ text: normalizedText }] }
  })
  return result.embedding.values
}

function getSafeModelText(response, label) {
  const text = response.text()?.trim()
  const looksLikeInternalFragment =
    !text ||
    text.length < 20 ||
    /^(null|undefined)[).,\s]*$/i.test(text) ||
    /^(we should|i should|the user|need to|let's)\b/i.test(text)

  if (!looksLikeInternalFragment) return text

  fastify.log.warn({
    label,
    finishReason: response.candidates?.[0]?.finishReason,
    text,
    parts: response.candidates?.[0]?.content?.parts
  }, 'Gemini returned unusable customer text')

  return 'I found some vehicle options for you. Which type of car are you interested in?'
}

async function processIncomingMessage({ customer_id, customer_message, vendor_id, channel }) {
  let botReply;

  try {
        fastify.log.info(`📥 ${channel} message from ${customer_id}: "${customer_message}"`);

        let { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('customer_id', customer_id)
          .eq('vendor_id', vendor_id)
          .eq('channel', channel)
          .eq('status', 'in_progress')
          .single();

        let previousBooking = null;

        if (!booking) {
          const { data: previousBookings } = await supabase
            .from('bookings')
            .select('customer_name, selected_vehicle, product_id, rental_days, delivery_address, status, created_at')
            .eq('customer_id', customer_id)
            .eq('vendor_id', vendor_id)
            .eq('channel', channel)
            .neq('status', 'in_progress')
            .order('created_at', { ascending: false })
            .limit(1);

          previousBooking = previousBookings?.[0] || null;

          const { data: newBooking , error: bookingInsertError} = await supabase
            .from('bookings')
            .insert({
              customer_id,
              vendor_id,
              channel,
              customer_name: previousBooking?.customer_name || null,
              status: 'in_progress'
            })
            .select()
            .single();
            if (bookingInsertError) {
              fastify.log.error(
                { bookingInsertError, customer_id, vendor_id, channel },
                'Failed to create booking'
              );
              throw bookingInsertError;
            }

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

        const userVector = await embedText(customer_message)

        const { data: shortTermHistory } = await supabase
          .from('chat_history').select('role, content')
          .eq('vendor_id', vendor_id).eq('customer_id', customer_id).eq('channel', channel)
          .order('created_at', { ascending: false }).limit(1)

        const recentChatText = shortTermHistory && shortTermHistory.length > 0
          ? shortTermHistory.reverse().map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n')
          : "No recent conversation."

        const { data: longTermHistory } = await supabase.rpc('match_chat_history', {
          query_embedding: userVector, match_threshold: 0.5, match_count: 2, p_vendor_id: vendor_id, p_customer_id: customer_id
        })

        const pastContextText = longTermHistory && longTermHistory.length > 0
          ? longTermHistory.map(msg => `- ${msg.content}`).join('\n') : "No relevant past context."

        const { data: chunks } = await supabase.rpc('match_knowledge_chunks', {
          query_embedding: userVector, match_threshold: 0.5, match_count: 2, p_vendor_id: vendor_id
        })

        const policyString = chunks ? chunks.map(c => c.content).join('\n\n') : ""

        // ---------------------------------------------------------
        // 💡 2. THE CHECKOUT PROMPT RULE ADDED
        // ---------------------------------------------------------
        const systemPrompt = `
          You are a warm, conversational customer service assistant for a vehicle rental business.
          Sound natural, friendly, and human. Acknowledge personal details warmly when appropriate
          (for example, if someone says the rental is for their girlfriend, you can say that is sweet
          or romantic). Ask a relevant follow-up question instead of interrogating the customer.
          Keep every reply short: no more than 2 or 3 brief sentences, and ask at most one question.
          Do not use Markdown, asterisks, headings, long lists, or repeated information.
          Every reply must be complete and end naturally. Never stop halfway through a sentence or leave
          a question unfinished. Before replying, check that the final sentence is complete.
          Guide the customer to fill out all missing 'null' fields in their booking state.

          ${bookingStateText}

          CRITICAL RULES:
          1. Look at the CURRENT BOOKING STATE. If a field is null, ask ONE simple, friendly question to get that info.
          2. If the user provides any booking info, DO NOT just reply. You MUST use the update_booking tool to save it.
          3. AMBIGUITY RULE: If a user requests a vehicle (e.g., Highlander) that exists in MULTIPLE product categories (e.g., SUV Daily and SUV Weekly), do NOT guess the product_id. Instead, ask the user a single clarifying question to determine which category fits their needs.
          4. CHECKOUT RULE: When the booking state has NO null fields, ask whether they are ready to pay and offer exactly two choices: pay via link (a Paystack checkout link) or pay via transfer (temporary bank account details). If they choose a method, call generate_checkout with that method. Never choose a method for them.
          5. CATALOG RULE: When the customer asks what vehicles are available or asks about a vehicle, category, feature, or price, you MUST call search_products. Use 'all' for a general catalog request. Product details are available only through that tool.

          === POLICIES ===
          ${policyString}

          === MEMORY ===
          ${pastContextText}
          ${recentChatText}
          ${previousBooking ? `
          === PREVIOUS BOOKING CONTEXT ===
          The current booking is new. The customer's previous booking was:
          - Name: ${previousBooking.customer_name || 'unknown'}
          - Vehicle: ${previousBooking.selected_vehicle || 'unknown'}
          - Product ID: ${previousBooking.product_id || 'unknown'}
          - Days: ${previousBooking.rental_days || 'unknown'}
          - Address: ${previousBooking.delivery_address || 'unknown'}
          Use this only as context. Do not assume the previous vehicle, duration, or address for the current booking.
          ` : ''}
        `;

        const requestPayload = {
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUSER: ${customer_message}` }] }],
          tools: tools,
          generationConfig: { maxOutputTokens: 1000, temperature: 0.5 }
        };

        const aiResponse = await chatModel.generateContent(requestPayload);
        fastify.log.info({
          finishReason: aiResponse.response.candidates?.[0]?.finishReason,
          text: aiResponse.response.text()
        }, 'Gemini response');
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

          else if (functionCall.name === 'search_products') {
            fastify.log.info(`🛠️ AI Fired Tool: Searching products for ${customer_id}`, args);

            const searchTerm = String(args.search_term || 'all').trim();
            let productQuery = supabase
              .from('products')
              .select('id, product_name, price, currency, description')
              .eq('vendor_id', vendor_id)
              .limit(10);

            if (searchTerm.toLowerCase() !== 'all') {
              const safeSearchTerm = searchTerm.replace(/[%,]/g, ' ').trim();
              productQuery = productQuery.or(
                `product_name.ilike.%${safeSearchTerm}%,description.ilike.%${safeSearchTerm}%`
              );
            }

            const { data: matchingProducts, error: productSearchError } = await productQuery;
            if (productSearchError) {
              toolResponseData = { status: 'error', message: 'Product search is temporarily unavailable.' };
            } else {
              toolResponseData = {
                status: 'success',
                search_term: searchTerm,
                products: (matchingProducts || []).map(product => ({
                  id: product.id,
                  name: product.product_name,
                  price: product.price,
                  currency: product.currency,
                  description: product.description
                }))
              };
            }
          }
          
          else if (functionCall.name === 'generate_checkout') {
            fastify.log.info(`🛠️ AI Fired Tool: Generating Checkout for ${customer_id}`);

            const paymentMethod = args.payment_method;
            if (!['paystack_link', 'transfer'].includes(paymentMethod)) {
              toolResponseData = { status: 'error', message: 'Ask the customer to choose pay via link or pay via transfer.' };
            } else {

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
                channel,
                amount_expected: totalNaira, 
                payment_status: 'pending',
                vendor_id: vendor_id,                 
                product_id: booking.product_id,      
                product_purchased: booking.selected_vehicle
              })
  .select().single();
            // Link the new order to the booking
            await supabase.from('bookings').update({ order_id: newOrder.id }).eq('id', booking.id);
            const paystackEndpoint = paymentMethod === 'paystack_link'
              ? 'https://api.paystack.co/transaction/initialize'
              : 'https://api.paystack.co/charge';
            const paystackBody = paymentMethod === 'paystack_link'
              ? { email: `customer_${String(customer_id).replace(/\D/g, '')}@jkrentals.com`, amount: totalKobo }
              : {
                  email: `customer_${String(customer_id).replace(/\D/g, '')}@jkrentals.com`,
                  amount: totalKobo,
                  bank_transfer: { account_expires_at: new Date(Date.now() + 30 * 60000).toISOString() }
                };

            const paystackResponse = await fetch(paystackEndpoint, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY.replace(/[\'"]/g, '').trim()}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(paystackBody)
            });

            const paystackData = await paystackResponse.json();
            // Extract account details and update database
            if (paymentMethod === 'paystack_link' && paystackResponse.ok && paystackData.status && paystackData.data?.authorization_url) {
              await supabase.from('orders').update({
                paystack_reference: paystackData.data.reference
              }).eq('id', newOrder.id);

              toolResponseData = {
                status: 'success',
                payment_method: 'paystack_link',
                total_amount: `₦${totalNaira}`,
                checkout_link: paystackData.data.authorization_url
              };
            } else if (paymentMethod === 'transfer' && paystackResponse.ok && paystackData.status && paystackData.data?.status === 'pending_bank_transfer') {
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
              toolResponseData = { status: 'error', message: 'Could not generate the selected payment option right now.' };
            }
            }
          }

          // Generate customer-facing text separately so the model cannot chain another tool call.
          const followUp = await chatModel.generateContent({
            contents: [{
              role: 'user',
              parts: [{ text: `${systemPrompt}

The internal action has already been completed. Do not call any tool and do not discuss internal actions.
Use the result below to write only one short, complete, customer-facing reply.

Customer message:
${customer_message}

Action result:
${JSON.stringify(toolResponseData)}` }]
            }],
            generationConfig: { maxOutputTokens: 1000, temperature: 0.4 }
          });

          botReply = getSafeModelText(followUp.response, 'follow-up');
          fastify.log.info({
            finishReason: followUp.response.candidates?.[0]?.finishReason,
            text: botReply, 
            toolResponseData,
            followUp
          }, 'Gemini follow-up response');
        } else {
          // Standard reply if no tool was fired
          botReply = getSafeModelText(aiResponse.response, 'initial');
        }

        await supabase.from('chat_history').insert({
          vendor_id, customer_id, channel, role: 'user', content: customer_message, embedding: userVector
        })
        const botVector = await embedText(botReply)
        await supabase.from('chat_history').insert({
          vendor_id, customer_id, channel, role: 'assistant', content: botReply, embedding: botVector
        })

        await sendOutboundMessage({ channel, customer_id, botReply });
        return botReply;

  } catch (error) {
    fastify.log.error(error)
    throw error
  }
}

fastify.post('/webhook-test', async (request, reply) => {
  const body = request.body;
  const messageObj = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (body?.object !== 'whatsapp_business_account' || messageObj?.type !== 'text') {
    return reply.send({ status: 'ignored' });
  }

  try {
    const botReply = await processIncomingMessage({
      customer_id: messageObj.from,
      customer_message: messageObj.text.body,
      vendor_id: 'a5f7f363-4ef1-4c66-bf59-27211a0d5f27',
      channel: 'whatsapp'
    });

    return reply.send({ status: 'success', bot_reply: botReply });
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({ error: error.message });
  }
});

fastify.post('/telegram-webhook', async (request, reply) => {
  const message = request.body?.message;
  const chatId = message?.chat?.id;
  const customerMessage = message?.text;

  if (!chatId || typeof customerMessage !== 'string') {
    return reply.code(200).send({ status: 'ignored' });
  }

  await enqueueTelegramMessage({
    update_id: request.body?.update_id,
    customer_id: chatId,
    customer_message: customerMessage
  })

  return reply.code(200).send({ status: 'queued' });
});

fastify.listen({
  port: Number(process.env.PORT) || 3000,
  host: '0.0.0.0'
}, (err, address) => {
  if (err) process.exit(1)
  startTelegramQueueWorker()
  console.log(`🚀 Server listening with Checkout Engine on ${address}`)
})