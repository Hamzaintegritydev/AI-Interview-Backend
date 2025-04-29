const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();
const app = express();
app.use(cors());
const PORT = process.env.PORT || 5000;

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Store interview data in memory for the session
let currentInterviewData = {
  jobPosition: null,
  experienceLevel: null,
  questions: [],
  answers: [],
  timestamps: [],
  interviewStartTime: null,
  interviewEndTime: null
};

// API keys for Gemini AI and ElevenLabs
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY'; 
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'YOUR_ELEVENLABS_API_KEY';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Default to "Adam" voice

// Helper function to extract text from Gemini API response
function extractTextFromResponse(response) {
  try {
    if (response.candidates && response.candidates[0].content) {
      const content = response.candidates[0].content;
      if (content.parts && Array.isArray(content.parts)) {
        return content.parts.map(part => part.text || '').join(' ');
      }
    }
    return "Could you tell me about your experience?"; // Fallback question
  } catch (error) {
    console.error('Error extracting text:', error);
    return "Could you tell me about your experience?"; // Fallback question
  }
}

// Generate speech audio from text using ElevenLabs API
async function generateSpeech(text) {
  try {
    const response = await axios({
      method: 'POST',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      data: {
        text: text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      },
      responseType: 'arraybuffer'
    });

    // Convert audio buffer to base64
    const audioBase64 = Buffer.from(response.data).toString('base64');
    return audioBase64;
  } catch (error) {
    console.error('Error generating speech:', error.response?.data || error.message);
    return null;
  }
}

// Generate initial interview question
app.post('/start-interview', async (req, res) => {
  const { jobPosition, experienceLevel } = req.body;
  
  try {
    // Reset interview data
    currentInterviewData = {
      jobPosition: jobPosition || 'Software Engineer',
      experienceLevel: experienceLevel || 'Mid-level',
      questions: [],
      answers: [],
      timestamps: [],
      interviewStartTime: new Date(),
      interviewEndTime: null
    };
    
    // Generate first question based on job position
    const prompt = `You are conducting a live interview for a ${jobPosition} position (${experienceLevel} level).
    Generate a natural, conversational opening question that would be asked in a real interview.
    Make it sound natural, as if you're speaking in a video call. 
    The first question should be an ice-breaker like "How are you today?" or "Tell me about yourself".
    Provide only the question without any additional text.`;
    
    const apiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    let question = extractTextFromResponse(apiResponse.data);
    
    // Generate audio for the question
    const audioBase64 = await generateSpeech(question);
    
    // Store the first question
    currentInterviewData.questions.push(question);
    currentInterviewData.timestamps.push(new Date());
    
    res.json({ 
      question,
      audio: audioBase64
    });
  } catch (error) {
    console.error('Error starting interview:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to start interview' });
  }
});

// Process candidate's answer and generate next question
app.post('/process-answer', async (req, res) => {
  const { answer } = req.body;
  
  // Store the previous answer
  if (answer) {
    currentInterviewData.answers.push(answer);
  }
  
  // Check if interview time is up (10 minutes)
  const currentTime = new Date();
  const interviewDuration = (currentTime - currentInterviewData.interviewStartTime) / (1000 * 60); // in minutes
  
  if (interviewDuration >= 10) {
    // Interview is complete
    currentInterviewData.interviewEndTime = currentTime;
    
    // Generate ending message audio
    const endMessage = "Thank you for your time. The interview is now complete.";
    const audioBase64 = await generateSpeech(endMessage);
    
    return res.json({
      isComplete: true,
      message: endMessage,
      audio: audioBase64
    });
  }
  
  try {
    // Get all previous questions and answers for context
    let context = "";
    for (let i = 0; i < currentInterviewData.questions.length; i++) {
      context += `Interviewer: ${currentInterviewData.questions[i]}\n`;
      if (currentInterviewData.answers[i]) {
        context += `Candidate: ${currentInterviewData.answers[i]}\n`;
      }
    }
    
    // Generate follow-up question
    const prompt = `You are conducting a live video interview for a ${currentInterviewData.jobPosition} position (${currentInterviewData.experienceLevel} level).
    
    Here is the conversation so far:
    ${context}
    
    Based on this conversation, generate the next logical interview question. The question should:
    1. Follow naturally from the candidate's previous answer
    2. Help evaluate the candidate's skills, experience, and cultural fit
    3. Be conversational and natural, like how a real interviewer would speak in a live video call
    4. Be specific rather than generic when possible
    5. Sometimes include follow-up questions to the previous answer if appropriate
    
    Avoid stating that you're an AI. Imagine you're a real human interviewer. Provide only the question without any additional text or explanation.`;
    
    const apiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    let question = extractTextFromResponse(apiResponse.data);
    
    // Generate audio for the question
    const audioBase64 = await generateSpeech(question);
    
    // Store the question
    currentInterviewData.questions.push(question);
    currentInterviewData.timestamps.push(new Date());
    
    // Calculate remaining time
    const remainingMinutes = Math.max(0, 10 - interviewDuration).toFixed(1);
    
    res.json({
      question,
      audio: audioBase64,
      remainingTime: remainingMinutes,
      questionCount: currentInterviewData.questions.length
    });
  } catch (error) {
    console.error('Error generating next question:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate next question' });
  }
});

// Complete the interview and generate evaluation
// Update this section in your complete-interview endpoint
app.post('/complete-interview', async (req, res) => {
  // Add the final answer if provided
  if (req.body.finalAnswer) {
    currentInterviewData.answers.push(req.body.finalAnswer);
  }
  
  currentInterviewData.interviewEndTime = new Date();
  
  // Generate interview transcript
  let transcript = `Interview for ${currentInterviewData.jobPosition} (${currentInterviewData.experienceLevel} level)\n`;
  transcript += `Date: ${currentInterviewData.interviewStartTime.toISOString()}\n`;
  transcript += `Duration: ${((currentInterviewData.interviewEndTime - currentInterviewData.interviewStartTime) / (1000 * 60)).toFixed(2)} minutes\n\n`;
  
  for (let i = 0; i < currentInterviewData.questions.length; i++) {
    transcript += `Interviewer: ${currentInterviewData.questions[i]}\n`;
    transcript += `Candidate: ${currentInterviewData.answers[i] || "No answer provided"}\n\n`;
  }
  
  try {
    // Enhanced evaluation prompt with more detailed analysis requirements
    const evaluationPrompt = `
    You are an expert interviewer and talent evaluator specializing in ${currentInterviewData.jobPosition} roles.
    You have significant experience in identifying talent, evaluating technical and soft skills,
    and providing actionable feedback to candidates.
    
    Review the following interview transcript for a ${currentInterviewData.jobPosition} position (${currentInterviewData.experienceLevel} level):
    
    ${transcript}
    
    Provide a comprehensive evaluation including:
    
    1. An overall score from 1-10
    2. Key strengths demonstrated during the interview (identify at least 3-5 specific strengths with examples)
    3. Areas for improvement (identify at least 3-5 specific areas with examples from the interview)
    4. Technical skill assessment (evaluate the candidate's technical knowledge as demonstrated in the interview)
    5. Communication skills assessment (evaluate clarity, articulation, listening skills)
    6. Cultural fit assessment (evaluate alignment with typical company values)
    7. Problem-solving approach (analyze how the candidate approaches challenges)
    8. Specific examples from the interview that stood out (both positive and negative)
    9. Final hiring recommendation (Reject, Consider with Reservations, Consider, Strong Consider, Hire)
    10. A detailed paragraph of personalized feedback for the candidate
    11. Development plan with 3 specific recommendations for the candidate to improve
    
    Format your response in JSON with the following structure:
    {
      "score": number,
      "strengths": [{"strength": "string", "example": "string"}, ...],
      "improvementAreas": [{"area": "string", "example": "string"}, ...],
      "technicalAssessment": {
        "score": number,
        "analysis": "string"
      },
      "communicationAssessment": {
        "score": number,
        "analysis": "string"
      },
      "culturalFitAssessment": {
        "score": number,
        "analysis": "string"
      },
      "problemSolvingAssessment": {
        "score": number,
        "analysis": "string"
      },
      "standoutMoments": [{"type": "positive|negative", "moment": "string", "impact": "string"}, ...],
      "recommendation": "string",
      "feedback": "paragraph with detailed analysis",
      "developmentPlan": ["recommendation1", "recommendation2", "recommendation3"]
    }
    `;
    
    const apiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: evaluationPrompt }] }]
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    
    let evaluationText = extractTextFromResponse(apiResponse.data);
  
    // Log the raw response for debugging
    console.log("AI Response:", evaluationText);
    
    // Remove Markdown formatting (triple backticks)
    evaluationText = evaluationText.replace(/```json\s*|\s*```/g, '');
  
    let evaluation = JSON.parse(evaluationText);
    
    try {
      evaluation = JSON.parse(evaluationText);
    } catch (e) {
      console.error('Error parsing evaluation JSON:', e);
      evaluation = {
        score: 5,
        strengths: [{"strength": "Could not determine strengths", "example": "N/A"}],
        improvementAreas: [{"area": "Could not determine improvement areas", "example": "N/A"}],
        technicalAssessment: {
          score: 5,
          analysis: "Unable to generate technical assessment"
        },
        communicationAssessment: {
          score: 5,
          analysis: "Unable to generate communication assessment"
        },
        culturalFitAssessment: {
          score: 5,
          analysis: "Unable to generate cultural fit assessment"
        },
        problemSolvingAssessment: {
          score: 5,
          analysis: "Unable to generate problem-solving assessment"
        },
        standoutMoments: [{"type": "neutral", "moment": "Unable to determine standout moments", "impact": "N/A"}],
        recommendation: "Consider",
        feedback: "Unable to generate detailed feedback",
        developmentPlan: ["Unable to generate development plan"]
      };
    }
    
    // Generate audio for a thank you message with evaluation preview
    const thankYouMessage = "Thank you for completing this interview. I've prepared a comprehensive evaluation of your performance with specific strengths, areas for improvement, and a development plan to help you succeed in your next interview.";
    const audioBase64 = await generateSpeech(thankYouMessage);
    
    // Save interview data and evaluation to file
    const interviewRecord = {
      ...currentInterviewData,
      transcript,
      evaluation,
      timestamp: new Date()
    };
    
    // Use a unique filename based on timestamp
    const filename = `interview_${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(interviewRecord, null, 2));
    
    res.json({
      transcript,
      evaluation,
      audio: audioBase64,
      message: "Interview completed and detailed evaluation stored successfully"
    });
  } catch (error) {
    console.error('Error completing interview:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to complete interview evaluation' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});