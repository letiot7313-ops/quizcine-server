// index.js — QuizCine Server (Express + Socket.IO)
// Q1: Convertit automatiquement les liens Drive en uc?id=...
// Q2: Auto-correction open/mcq (normalisation stricte, pas de fuzzy)
// Lit public/questions.json (clé "questions": [])

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const QUESTIONS_PATH = path.join(__dirname, "public", "questions.json");

// ---- Helpers
function convertDrive(url) {
  if (!url || typeof url !== "string") return "";
  if (url.includes("/uc?id=")) return url;
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return `https://drive.google.com/uc?id=${m[1]}`;
  return url;
}
function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/\s+/g," ");
}
function safeQuestionText(s) {
  const t = String(s || "");
  const low = t.toLowerCase().trim();
  if (low === "mcq" || low === "open") return ""; // si ton JSON contient "mcq"/"open" dans question, on cache le texte
  return t;
}
function loadQuestions(){
  try {
    const raw = fs.readFileSync(QUESTIONS_PATH, "utf-8");
    const obj = JSON.parse(raw);
    const list = Array.isArray(obj?.questions) ? obj.questions : (Array.isArray(obj) ? obj : []);
    // normaliser images
    return list.map(q => ({
      round: q.round || "",
      type: (q.type || "").toLowerCase() === "open" ? "open" : "mcq",
      question: safeQuestionText(q.question),
      image: convertDrive(q.image || ""),
      // on ignore q.video volontairement (supprimées)
      choices: Array.isArray(q.choices) ? q.choices.filter(Boolean) : [],
      answer: q.answer || "",
      points: Number(q.points || 10),
      duration: Number(q.duration || 30),
      answerImage: convertDrive(q.answerImage || ""),
    }));
  } catch(e){
    console.error("Failed to load questions.json:", e);
    return [];
  }
}

// --- API simple pour contrôle
app.get("/", (_req,res)=> res.send("QuizCine Server OK"));
app.get("/questions", (_req,res)=> res.json({ questions: loadQuestions() }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// --- Room state
const rooms = new Map();
const STREAK_EVERY = 3, STREAK_BONUS = 5, QUICK_BONUS = 5;

function ensureRoom(code){
  if(!rooms.has(code)){
    rooms.set(code, {
      players: new Map(), // socket.id -> { name, score, streak }
      accepting: false,
      q: null,
      firstCorrect: null,
      qIndex: -1,
      round: "",
    });
  }
  return rooms.get(code);
}
function roomScores(code){
  const r = ensureRoom(code);
  return Object.fromEntries([...r.players.entries()].map(([sid, p]) => [sid, { name: p.name, score: p.score|0 }]));
}

// --- Socket handlers
io.on("connection", (socket) => {

  // Joueur
  socket.on("join", ({room, name})=>{
    if(!room || !name) return;
    const code = String(room).toUpperCase();
    const r = ensureRoom(code);
    socket.join(code);
    r.players.set(socket.id, { name, score: 0, streak: 0 });
    socket.emit("joined");
    io.to(code).emit("player-joined", { id: socket.id, name });
    io.to(code).emit("scores", roomScores(code));
  });

  // Host: se mettre dans la salle
  socket.on("host-join", ({room})=>{
    if(!room) return;
    const code = String(room).toUpperCase();
    ensureRoom(code);
    socket.join(code);
    io.to(socket.id).emit("scores", roomScores(code));
  });

  // Host: charger un round (par nom exact)
  socket.on("start-from-server", ({room, round})=>{
    const code = String(room || "").toUpperCase();
    const r = ensureRoom(code);
    r.round = String(round || "");
    r.qIndex = -1;
    const list = loadQuestions().filter(q => norm(q.round) === norm(r.round));
    io.to(socket.id).emit("server-round-loaded", { count: list.length });
  });

  // Host: question suivante (depuis le fichier questions.json filtré par round)
  socket.on("next-from-server", ({room})=>{
    const code = String(room || "").toUpperCase();
    const r = ensureRoom(code);
    const list = loadQuestions().filter(q => norm(q.round) === norm(r.round));
    if (list.length === 0){
      io.to(code).emit("log", "Aucune question dans ce round.");
      return;
    }
    r.qIndex = Math.min(r.qIndex + 1, list.length - 1);
    const q = list[r.qIndex];
    r.q = q;
    r.accepting = true;
    r.firstCorrect = null;

    io.to(code).emit("question", {
      type: q.type,
      text: q.question || "",
      image: q.image || "",
      choices: q.type === "mcq" ? (q.choices || []) : [],
      duration: Number(q.duration || 30)
    });
    io.to(code).emit("accepting", true);
  });

  // Host: question manuelle (option)
  socket.on("start-question", (payload)=>{
    const { room, type, text, image, choices, answer, points, duration } = payload || {};
    const code = String(room || "").toUpperCase();
    const r = ensureRoom(code);
    r.q = {
      type: (type || "mcq"),
      question: safeQuestionText(text),
      image: convertDrive(image || ""),
      choices: Array.isArray(choices) ? choices.filter(Boolean).slice(0,4) : [],
      answer: answer || "",
      points: Number(points || 10),
      duration: Number(duration || 30),
      answerImage: ""
    };
    r.accepting = true;
    r.firstCorrect = null;

    io.to(code).emit("question", {
      type: r.q.type,
      text: r.q.question,
      image: r.q.image,
      choices: r.q.type === "mcq" ? r.q.choices : [],
      duration: r.q.duration
    });
    io.to(code).emit("accepting", true);
  });

  // Joueur: répondre
  socket.on("answer", ({room, name, answer})=>{
    if(!room) return;
    const code = String(room).toUpperCase();
    const r = ensureRoom(code);
    const q = r.q;
    if(!r.accepting || !q) return;

    const p = r.players.get(socket.id);
    if(!p) return;

    const expected = norm(q.answer);
    const got      = norm(answer);

    let correct = false;
    if (q.type === "mcq") {
      // MCQ: compare texte-normalisé des choix ou exact du bouton cliqué
      correct = got === expected;
    } else {
      // OPEN: auto-correction stricte (normalisée)
      correct = got === expected;
    }

    // maj scores + bonus
    if (correct) {
      p.score = (p.score || 0) + (q.points || 10);
      if (!r.firstCorrect) {
        r.firstCorrect = socket.id;
        p.score += 5; // QUICK_BONUS
      }
      p.streak = (p.streak || 0) + 1;
      if (p.streak >= 3) { // STREAK_EVERY
        p.score += 5; // STREAK_BONUS
        p.streak = 0;
      }
    } else {
      p.streak = 0;
    }

    io.to(code).emit("scores", roomScores(code));
  });

  // Host: révéler
  socket.on("reveal", ({room})=>{
    if(!room) return;
    const code = String(room).toUpperCase();
    const r = ensureRoom(code);
    const q = r.q;
    r.accepting = false;
    io.to(code).emit("accepting", false);
    io.to(code).emit("reveal", {
      answer: q?.answer || "",
      answerImage: q?.answerImage || ""
    });
    io.to(code).emit("scores", roomScores(code));
  });

  // Clean up
  socket.on("disconnect", ()=>{
    // on laisse les scores, c'est ok
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log("QuizCine server listening on", PORT);
});
