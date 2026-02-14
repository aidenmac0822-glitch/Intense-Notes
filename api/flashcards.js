import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const { text } = req.body;

    if (!text || text.length < 10) {
      return res.status(400).json({ error: "Text too short" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            'Return ONLY valid JSON in this format: {"cards":[{"question":"","answer":""}]}. Make 8 flashcards.'
        },
        {
          role: "user",
          content: text
        }
      ],
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0].message.content;
    const parsed = JSON.parse(content);

    res.status(200).json({ cards: parsed.cards });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
}