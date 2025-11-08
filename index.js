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

/* -------------------- Utils: normalize + Drive -------------------- */
const normalize = s =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function driveToDirect(u) {
  if (!u) return "";
  const url = String(u).trim();
  if (url.includes("drive.google.com/uc?id=")) return url;
  // /file/d/<id>/view?...  OR open?id=<id>
  const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const id = (m1 && m1[1]) || (m2 && m2[1]);
  return id ? `https://drive.google.com/uc?id=${id}` : url;
}

/* -------------------- Load questions -------------------- */
function loadQuestions() {
  try {
    const raw = fs.readFileSync(QUESTIONS_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data?.questions)) return data.questions;
    if (Array.isArray(data)) return data;
    return [];
  } catch (e) {
    console.error("❌ Erreur questions.json:", e.message);
    return [];
  }
}

/* -------------------- Field mappers (robustes) -------------------- */
function pickText(q) {
  // Dans ton export, "question" contient parfois "open"/"mcq".
  // On prend d'abord text-like, sinon on retombe sur 'question' si ce n’est pas un type.
  const candidates = [
    q.text,
    q.questionText,
    q.prompt,
    q.Texte,
    q.titre,
    q.label,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c);
  }
  const maybe = q.question;
  if (maybe && !["open", "mcq"].includes(String(maybe).toLowerCase())) {
    return String(maybe);
  }
  return ""; // dernier recours
}

function pickImage(q) {
  // Ton fichier utilise qImage pour l’énoncé.
  const candidates = [
    q.image,
    q.qImage,
    q.Image,
    q["Image question"],
    q["image_question"],
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return driveToDirect(String(c));
  }
  return "";
}

function pickAnswerImage(q) {
  const candidates = [
    q.answerImage,
    q["Image réponse"],
    q["image_reponse"],
    q.answer_img,
    q.imgAnswer,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return driveToDirect(String(c));
  }
  return "";
}

function pickType(q) {
  const t = (q.type || q.Type || q["type de question"] || q["Type de question"] || "").toString().toLowerCase();
  if (t === "mcq" || t === "open") return t;
  // fallback: si "choices" non vide => mcq, sinon open
  return Array.isArray(q.choices) && q.choices.length ? "mcq" : "open";
}

function pickChoices(q) {
  // déjà array ?
  if (Array.isArray(q.choices)) return q.choices.filter(Boolean);
  // colonnes 1..4 éventuelles
  const cands = [q["Choix 1"], q["Choix 2"], q["Choix 3"], q["Choix 4"]];
  return cands.filter(Boolean);
}

function pickPoints(q) {
  const p = Number(q.points ?? q.Points ?? q.score);
  return Number.isFinite(p) && p > 0 ? p : 10;
}

function pickDuration(q) {
  const d = Number(q.duration ?? q.Durée ?? q.time ?? q.timer);
  return Number.isFinite(d) && d > 0 ? d : 30;
}

function mapQuestion(qRaw) {
  // Round exact (conserve casse mais normalise pour comparaison)
  const round = qRaw.round ?? qRaw["Manche"] ?? "";
  return {
    round: String(round || ""),
    type: pickType(qRaw),
    text: pickText(qRaw),
    image: pickImage(qRaw),
    choices: pickChoices(qRaw),
    answer: String(qRaw.answer ?? qRaw["Réponse"] ?? ""),
    answerImage: pickAnswerImage(qRaw),
    points: pickPoints(qRaw),
    duration: pickDuration(qRaw),
    allowChange: true,
  };
}

/* -------------------- HTTP -------------------- */
app.get("/", (_req, res) => res.send("✅ QuizCine Server OK"));
app.get("/questions", (_req, res) => {
  const raw = loadQuestions();
  const mapped = raw.map(mapQuestion);
  res.json({ questions: mapped });
});

/* -------------------- Socket.IO -------------------- */
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET", "POST"] } });

const STREAK_EVERY = 3;
const STREAK_BONUS = 5;
const QUICK_BONUS = 5;

const rooms = new Map();
const ensureRoom = code => {
  if (!rooms.has(code)) {
    rooms.set(code, {
      players: new Map(),
      accepting: false,
      question: null,
      firstCorrect: null,
      qIndex: -1,
      round: "",
    });
  }
  return rooms.get(code);
};
const roomScores = code => {
  const r = ensureRoom(code);
  return Object.fromEntries(
    [...r.players.entries()].map(([sid, p]) => [sid, { name: p.name, score: p.score | 0 }])
  );
};

io.on("connection", socket => {
  socket.on("join", ({ room, name }) => {
    if (!room || !name) return;
    const code = room.toUpperCase();
    socket.join(code);
    const r = ensureRoom(code);
    r.players.set(socket.id, { name, score: 0, streak: 0 });
    socket.emit("joined");
    io.to(code).emit("player-joined", { id: socket.id, name });
    io.to(code).emit("scores", roomScores(code));
  });

  socket.on("host-join", ({ room }) => {
    if (!room) return;
    const code = room.toUpperCase();
    socket.join(code);
    io.to(socket.id).emit("scores", roomScores(code));
  });

  socket.on("start-from-server", ({ room, round }) => {
    const code = (room || "").toUpperCase();
    const r = ensureRoom(code);
    r.round = round || "";
    r.qIndex = -1;

    const list = loadQuestions().map(mapQuestion).filter(
      q => normalize(q.round) === normalize(r.round)
    );
    io.to(socket.id).emit("server-round-loaded", { count: list.length });
  });

  socket.on("next-from-server", ({ room }) => {
    const code = (room || "").toUpperCase();
    const r = ensureRoom(code);

    const list = loadQuestions().map(mapQuestion).filter(
      q => normalize(q.round) === normalize(r.round)
    );

    r.qIndex = Math.min(r.qIndex + 1, list.length - 1);
    const q = list[r.qIndex];
    if (!q) {
      io.to(code).emit("log", "✅ Plus de questions dans cette manche.");
      return;
    }

    r.accepting = true;
    r.firstCorrect = null;
    r.question = q;

    io.to(code).emit("question", {
      type: q.type,
      text: q.text,
      image: q.image,
      choices: q.choices,
      allowChange: q.allowChange,
      duration: q.duration,
    });
    io.to(code).emit("accepting", true);
  });

  socket.on("start-question", (qIn) => {
    if (!qIn || !qIn.room) return;
    const code = qIn.room.toUpperCase();
    const r = ensureRoom(code);

    // Accepte aussi un envoi manuel depuis le Host
    const q = {
      type: qIn.type || "mcq",
      text: qIn.text || "",
      image: driveToDirect(qIn.image || ""),
      choices: Array.isArray(qIn.choices) ? qIn.choices.filter(Boolean) : [],
      answer: qIn.answer || "",
      answerImage: driveToDirect(qIn.answerImage || ""),
      points: Number(qIn.points || 10),
      duration: Number(qIn.duration || 30),
      allowChange: true,
    };

    r.question = q;
    r.accepting = true;
    r.firstCorrect = null;

    io.to(code).emit("question", {
      type: q.type,
      text: q.text,
      image: q.image,
      choices: q.choices,
      allowChange: q.allowChange,
      duration: q.duration,
    });
    io.to(code).emit("accepting", true);
  });

  socket.on("answer", ({ room, name, answer }) => {
    if (!room) return;
    const code = room.toUpperCase();
    const r = ensureRoom(code);
    if (!r.accepting || !r.question) return;
    const p = r.players.get(socket.id);
    if (!p) return;

    io.to(code).emit("answer-received", { id: socket.id, name: p.name, answer });

    const good = normalize(answer) === normalize(r.question.answer);
    if (good) {
      p.score = (p.score || 0) + (r.question.points || 0);
      if (!r.firstCorrect) {
        r.firstCorrect = socket.id;
        p.score += QUICK_BONUS;
      }
      p.streak = (p.streak || 0) + 1;
      if (p.streak >= STREAK_EVERY) {
        p.score += STREAK_BONUS;
        p.streak = 0;
      }
    } else {
      p.streak = 0;
    }
    io.to(code).emit("scores", roomScores(code));
  });

  socket.on("reveal", ({ room }) => {
    if (!room) return;
    const code = room.toUpperCase();
    const r = ensureRoom(code);
    r.accepting = false;
    io.to(code).emit("accepting", false);
    io.to(code).emit("reveal", {
      answer: r.question?.answer || "",
      answerImage: r.question?.answerImage || "",
    });
    io.to(code).emit("scores", roomScores(code));
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => console.log("✅ QuizCine server listening on", PORT));
