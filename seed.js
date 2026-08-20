// require('dotenv').config()
// const fs = require('fs')
// const { createClient } = require('@supabase/supabase-js')
// const { GoogleGenerativeAI } = require('@google/generative-ai')

// // Initialize Supabase and Gemini clients
// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// // The UUID for JK Rentals in your `vendors` table
// const VENDOR_ID = "a5f7f363-4ef1-4c66-bf59-27211a0d5f27" 

// async function processAndStoreDocument() {
//   console.log(`🚀 Starting RAG Data Prep for JK Rentals (Vendor: ${VENDOR_ID})...\n`)

//   // 1. Read the text file
//  const rawText = fs.readFileSync('./BusinessDoc/jk_rentals.txt', 'utf8')

//   // 2. The Chunking Logic
//   // We split the document by double line breaks to isolate paragraphs/sections
//   const rawChunks = rawText.split(/\n\s*\n/)
  
//   // Filter out any empty chunks or very short lines (like page numbers)
//   const validChunks = rawChunks.filter(chunk => chunk.trim().length > 50)

//   console.log(`📄 Document successfully split into ${validChunks.length} logical chunks.\n`)

//   // Initialize the Gemini embedding model
//  const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" })

//   // 3. Loop through, Embed, and Store
//   for (let i = 0; i < validChunks.length; i++) {
//     const chunkText = validChunks[i].trim()
    
//     // We will use the first 50 characters of the chunk as a "title"
//     const chunkTitle = chunkText.substring(0, 50).replace(/\n/g, ' ') + '...'

//     try {
//       console.log(`🧠 Embedding chunk ${i + 1}/${validChunks.length}: "${chunkTitle}"`)
      
//       // Generate the vector array using Gemini
//       const result = await embeddingModel.embedContent(chunkText)
//       const vectorArray = result.embedding.values // 768-dimensional array

//       // Store in Supabase
//       // Note: We are using the `products` table as a general "knowledge base" table here.
//       const { error } = await supabase
//         .from('chunks')
//         .insert({
//           vendor_id: VENDOR_ID,
//           product_name: `JK Rentals Doc - Part ${i + 1}`, // Generic title
//           price: 0, // 0 since this might be a policy/FAQ chunk, not a specific car price
//           description: chunkText, // The actual text the AI will read later
//           embedding: vectorArray 
//         })

//       if (error) throw error

//     } catch (err) {
//       console.error(`❌ Error processing chunk ${i + 1}:`, err.message)
//     }
    
//     // Slight delay to avoid hitting rate limits on the free Gemini API
//     await new Promise(resolve => setTimeout(resolve, 500))
//   }
  
//   console.log("\n🎉 JK Rentals knowledge base completely embedded and stored!")
// }

// // Run the script
// processAndStoreDocument()


require('dotenv').config()
const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai')

// Initialize Supabase and Gemini
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// Define the exact JSON structure we want Gemini to extract for the catalog
const productSchema = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      product_name: { type: SchemaType.STRING, description: "The name of the vehicle or rental package" },
      price: { type: SchemaType.NUMBER, description: "The numeric price. If no explicit price is found, leave blank.", nullable: true },
      currency: { type: SchemaType.STRING, description: "The currency code, defaulting to NGN" },
      description: { type: SchemaType.STRING, description: "A brief description of what is included or recommended use cases" }
    },
    required: ["product_name", "description"]
  }
}

async function getOrCreateVendor() {
  const businessName = "JK Rentals"
  const { data: existingVendor } = await supabase.from('vendors').select('id').eq('business_name', businessName).single()
  
  if (existingVendor) return existingVendor.id

  const { data: newVendor } = await supabase.from('vendors').insert({
      business_name: businessName,
      system_prompt: "You are a polite, professional customer service rep for JK Rentals."
    }).select('id').single()
  return newVendor.id
}

async function processAndStoreDocument() {
  try {
    const VENDOR_ID = await getOrCreateVendor()
    console.log(`\n🚀 Starting Two-Pass Data Ingestion for Vendor: ${VENDOR_ID}...\n`)

    const rawText = fs.readFileSync('./BusinessDoc/jk_rentals.txt', 'utf8')

    // ==========================================
    // PASS 1: EXTRACT STRUCTURED CATALOG
    // ==========================================
    console.log("🛒 PASS 1: Extracting structured product catalog with Gemini...")
    
    // We use a chat model here (like 1.5-flash) to parse the text and generate JSON
    const chatModel = genAI.getGenerativeModel({
      model: "gemini-3.6-flash", 
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: productSchema,
      }
    })

    const prompt = `Read the following vendor documentation and extract every vehicle category, rental plan, or specific service offered. Return them matching the requested JSON schema.\n\nDocument Text:\n${rawText}`
    const extractionResult = await chatModel.generateContent(prompt)
    
    // Parse the JSON output from Gemini
    const extractedProducts = JSON.parse(extractionResult.response.text())
    console.log(`✅ Gemini found ${extractedProducts.length} distinct products/services. Saving to database...`)

    // Save to the `products` table
    for (const prod of extractedProducts) {
      await supabase.from('products').insert({
        vendor_id: VENDOR_ID,
        product_name: prod.product_name,
        price: prod.price || null,
        currency: prod.currency || 'NGN',
        description: prod.description
      })
    }


    // ==========================================
    // PASS 2: EMBED KNOWLEDGE CHUNKS
    // ==========================================
    console.log("\n🧠 PASS 2: Chunking and embedding knowledge base (FAQs, Policies)...")
    
    const rawChunks = rawText.split(/\n\s*\n/)
    const validChunks = rawChunks.filter(chunk => chunk.trim().length > 50)
    console.log(`📄 Document successfully split into ${validChunks.length} logical chunks.\n`)

    const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" })

    for (let i = 0; i < validChunks.length; i++) {
      const chunkText = validChunks[i].trim()
      const chunkTitle = chunkText.substring(0, 50).replace(/\n/g, ' ') + '...'

      try {
        console.log(`🧠 Embedding chunk ${i + 1}/${validChunks.length}: "${chunkTitle}"`)
        const result = await embeddingModel.embedContent(chunkText)
        const vectorArray = result.embedding.values // The 3072-dimensional array

        // Save to the `knowledge_chunks` table
        await supabase.from('knowledge_chunks').insert({
            vendor_id: VENDOR_ID,
            content: chunkText,
            embedding: vectorArray 
          })
      } catch (err) {
        console.error(`❌ Error processing chunk ${i + 1}:`, err.message)
      }
      await new Promise(resolve => setTimeout(resolve, 300)) // Rate limit buffer
    }
    
    console.log("\n🎉 Two-Pass Ingestion Complete! Both Logical Catalog and Vector Memory are ready!")

  } catch (err) {
    console.error("❌ Fatal Error:", err.message)
  }
}

processAndStoreDocument()