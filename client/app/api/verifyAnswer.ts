import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { quizId, playerAddress, questionIndex, answer } = req.body;
    if (
      !quizId ||
      !playerAddress ||
      questionIndex === undefined ||
      answer === undefined
    ) {
      console.error("Invalid input:", {
        quizId,
        playerAddress,
        questionIndex,
        answer,
      });
      return res
        .status(400)
        .json({
          error: "quizId, playerAddress, questionIndex, and answer required",
        });
    }

    const questionIdx = parseInt(questionIndex);
    if (isNaN(questionIdx) || questionIdx < 0 || questionIdx >= 10) {
      console.error("Invalid questionIndex:", questionIdx);
      return res
        .status(400)
        .json({ error: "Invalid questionIndex: must be 0 to 9" });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("Missing environment variables");
      return res
        .status(500)
        .json({
          error: "Server configuration error: Missing environment variables",
        });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    console.log("Fetching quiz from Supabase");
    const { data, error } = await supabase
      .from("Quizzes")
      .select(
        "questions, correct_count, num_questions, completed_at, player_address"
      )
      .eq("quiz_id", quizId)
      .single();

    if (error) {
      console.error("Supabase fetch error:", error);
      return res
        .status(500)
        .json({ error: `Supabase fetch failed: ${error.message}` });
    }

    if (data.player_address.toLowerCase() !== playerAddress.toLowerCase()) {
      console.error("Player address mismatch:", { quizId, playerAddress });
      return res
        .status(403)
        .json({ error: "Unauthorized: player address does not match" });
    }

    const questions = data.questions;
    const question = questions[questionIdx];
    if (!question) {
      console.error("Question not found at index:", questionIdx);
      return res
        .status(404)
        .json({ error: `Question not found at index ${questionIdx}` });
    }

    const isCorrect = parseInt(answer) === question.correctIndex;
    let newCorrectCount = data.correct_count;
    let newCompletedAt = data.completed_at;

    if (isCorrect) {
      newCorrectCount++;
      if (questionIdx === questions.length - 1)
        newCompletedAt = new Date().toISOString();
    }

    console.log("Updating quiz in Supabase");
    const { error: updateError } = await supabase
      .from("Quizzes")
      .update({ correct_count: newCorrectCount, completed_at: newCompletedAt })
      .eq("quiz_id", quizId);

    if (updateError) {
      console.error("Supabase update error:", updateError);
      return res
        .status(500)
        .json({ error: `Supabase update failed: ${updateError.message}` });
    }

    console.log("Answer verified:", { quizId, questionIndex, isCorrect });
    res.status(200).json({ isCorrect });
  } catch (error) {
    console.error("Error in /api/verifyAnswer:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
