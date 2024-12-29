"use server";

import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import { createClient } from "@/utils/supabase/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const cleanText = (text: string): string => {
  return text
    .replace(/\s+/g, " ") // Replace multiple spaces with single space
    .replace(/\\n+/g, "\\n") // Replace multiple newlines with single newline
    .replace(/\[\s*\]/g, "") // Remove empty brackets
    .replace(/\(\s*\)/g, "") // Remove empty parentheses
    .replace(/\s+([.,!?])/g, "$1") // Remove spaces before punctuation
    .replace(/\s+$/gm, "") // Remove trailing spaces
    .replace(/^\s+/gm, "") // Remove leading spaces
    .replace(/\b(Reply|Comment)\b/g, "") // Remove common blog artifacts
    .replace(/Loading\.\.\./g, "")
    .replace(/<[^>]*>/g, "") // Remove any remaining HTML tags
    .replace(/&[a-z]+;/gi, "") // Remove HTML entities
    .replace(/\s{2,}/g, " ") // Replace multiple spaces with single space
    .trim();
};

const splitIntoChunks = async (text: string): Promise<string[]> => {
  const systemPrompt = `You are an expert at breaking down complex information into simple, engaging text messages. Your task is to:
    1. Break down the given text into bite-sized chunks of 3-5 sentences each
    2. Make each chunk focus on a single concept or topic
    3. Write in a casual, text-message friendly style while keeping the information accurate
    4. Ensure each chunk is self-contained and easily understood
    5. Use simple language and explanatory analogies where helpful
    6. Keep each chunk under 500 characters
    7. Remove any unnecessary information or redundant content
    8. Make the information memorable and easy to understand
    9. If the text is instructional, break it into clear, actionable steps
    10. Maintain a friendly, conversational tone
  
  Output format should be a series of chunks separated by "|||". Each chunk should be a self-contained message.
  
  For example, if given a technical article about photosynthesis, good chunks would be:
  "🌱 Here's something cool: plants are basically solar-powered! They take sunlight and turn it into food using their leaves. The green color you see is from chlorophyll, which is like tiny solar panels inside the leaves. Pretty neat how nature figured that out! 🌞" ||| "💧 Water plays a huge role too! Plants drink it up from their roots and combine it with CO2 from the air. This chemical reaction helps create glucose - basically plant food! It's like they're running their own tiny food factory 🏭"`;

  try {
    // split text into smaller segments if it's too long
    const maxCharsPerRequest = 4000; // safe limit for context window
    const textSegments = [];
    for (let i = 0; i < text.length; i += maxCharsPerRequest) {
      textSegments.push(text.slice(i, i + maxCharsPerRequest));
    }

    let allChunks: string[] = [];

    // process each segment
    for (const segment of textSegments) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4-1106-preview", // need to experiment with different models
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `Please break this text into engaging, informative chunks that feel like text messages: ${segment}`,
          },
        ],
        temperature: 0.7, // balanced between creativity and consistency
        max_tokens: 2000,
      });

      const response = completion.choices[0]?.message?.content;

      if (!response) {
        console.warn("No response from GPT for segment");
        continue;
      }

      // split response into chunks and add to collection
      const newChunks = response
        .split("|||")
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);
      allChunks = [...allChunks, ...newChunks];
    }

    // Validate chunks
    allChunks = allChunks.filter((chunk) => {
      // ensure each chunk is within size limits and has actual content
      return (
        chunk.length > 0 &&
        chunk.length <= 500 &&
        chunk.split(/[.!?]+/).length >= 2
      ); // at least 2 sentences
    });

    if (allChunks.length === 0) {
      // fallback to simple chunking if GPT fails
      console.warn("GPT chunking failed, falling back to simple chunking");
      return text
        .split(/[.!?]+/)
        .reduce((acc: string[], sentence: string, i: number) => {
          if (i % 3 === 0) acc.push(sentence + ".");
          else if (acc.length > 0) acc[acc.length - 1] += " " + sentence + ".";
          return acc;
        }, [])
        .filter((chunk) => chunk.trim().length > 0);
    }

    console.log("all chunks: ", allChunks);

    return allChunks;
  } catch (error) {
    console.error("Error in GPT text chunking:", error);
    // fallback to simple chunking
    return text
      .split(/[.!?]+/)
      .reduce((acc: string[], sentence: string, i: number) => {
        if (i % 3 === 0) acc.push(sentence + ".");
        else if (acc.length > 0) acc[acc.length - 1] += " " + sentence + ".";
        return acc;
      }, [])
      .filter((chunk) => chunk.trim().length > 0);
  }
};

export async function scrapeUrl(url: string) {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    // remove unwanted elements
    $("script").remove();
    $("style").remove();
    $("comment").remove();
    $("iframe").remove();
    $("nav").remove();
    $("header").remove();
    $("footer").remove();
    $(".comments").remove();
    $("#comments").remove();
    $("img").remove();
    $('[class*="advertisement"]').remove();
    $('[id*="advertisement"]').remove();
    $('[class*="sidebar"]').remove();
    $('[id*="sidebar"]').remove();
    $('[class*="menu"]').remove();
    $('[id*="menu"]').remove();
    $('[class*="footer"]').remove();
    $('[id*="footer"]').remove();

    // some common selectors for articles (may need to update this as needed)
    const contentSelectors = [
      "article",
      "main",
      ".main-content",
      "#main-content",
      ".post-content",
      ".article-content",
      ".entry-content",
      ".content",
      '[role="main"]',
      "#content",
    ];

    let mainContent = "";
    for (const selector of contentSelectors) {
      const content = $(selector).text();
      if (content && content.length > mainContent.length) {
        mainContent = content;
      }
    }

    // if no main content found, get body text
    if (!mainContent) {
      mainContent = $("body").text();
    }

    const cleanedText = cleanText(mainContent);
    console.log("cleaned text: ", cleanedText);
    return splitIntoChunks(cleanedText);
  } catch (error) {
    console.error("Error scraping URL:", error);
    throw new Error("Failed to scrape URL");
  }
}

export async function parsePdf(file: Buffer) {
  try {
    const data = await pdfParse(file, {
      pagerender: function (pageData) {
        return pageData.getTextContent().then((content: { items: any[] }) => {
          const text = content.items.map((item) => item.str).join(" ");
          console.log("Text content for a page:", text);
          return text;
        });
      },
      max: 0,
    });

    const cleanedText = cleanText(data.text);
    console.log("cleaned text: ", cleanedText);
    return splitIntoChunks(cleanedText);
  } catch (error) {
    console.error("Error parsing PDF:", error);
    throw new Error("Failed to parse PDF");
  }
}

// Main submission handler
export async function handleSubmission(formData: FormData) {
  const supabase = await createClient();
  const url = formData.get("text") as string | null;
  const files = formData.getAll("files") as File[];
  const cadence = formData.get("cadence") as string;
  const repeat = formData.get("repeat") as string;

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    // Create submission record
    const { data: submission, error: submissionError } = await supabase
      .from("submissions")
      .insert({
        user_id: user.id,
        url: url || null,
        cadence,
        repeatable: repeat === "repeat-forever",
      })
      .select()
      .single();

    if (submissionError) throw submissionError;

    let allChunks: string[] = [];

    if (url?.trim()) {
      const urlChunks = await scrapeUrl(url);
      allChunks = [...allChunks, ...urlChunks];
    }

    if (files.length > 0) {
      for (const file of files) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const pdfChunks = await parsePdf(buffer);
        allChunks = [...allChunks, ...pdfChunks];
      }
    }

    if (allChunks.length > 0) {
      const { error: cadenceError } = await supabase.from("cadences").insert(
        allChunks.map((chunk) => ({
          submission_id: submission.submission_id,
          message_text: chunk,
        }))
      );
      if (cadenceError) throw cadenceError;
    }
    // console.log("chunks: ", allChunks);

    return {
      success: true,
      submission_id: "submission_id",
      chunks_count: allChunks.length,
    };
  } catch (error) {
    console.error("Error in handleSubmission:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to process submission");
  }
}
