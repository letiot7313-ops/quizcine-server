import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ✅ Fix ES modules path
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ✅ Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ✅ Load questions.json
const QUESTIONS_PATH = path.join(__dirname, "public", "questions.json");

function loadQuestions() {
    try {
        const raw = fs.readFileSync(QUESTIONS_PATH, "utf-8");
        const data = JSON.parse(raw);

        if (Array.isArray(data.questions)) return data.questions;
        if (Array.isArray(data)) return data;

        return [];
    } catch (e) {
        console.error("❌ Erreur chargement questions.json :", e);
        return [];
    }
}

// ✅ Test route
app.get("/", (_req, res) => res.send("✅ QuizCine Server OK"));
app.get("/questions", (_req, res) => res.json({ questions: loadQuestions() }));

// ✅ Socket.IO
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ✅ Utility
const normalize = s =>
    s.toString().trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

const STREAK_EVERY = 3;
const STREAK_BONUS = 5;
const QUICK_BONUS = 5;

// ✅ Rooms data structure
const rooms = new Map();

function ensureRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, {
            players: new Map(),
            accepting: false,
            question: null,
            firstCorrect: null,
            qIndex: -1,
            round: ""
        });
    }
    return rooms.get(code);
}

function roomScores(code) {
    const r = ensureRoom(code);
    return Object.fromEntries(
        [...r.players.entries()].map(([id, p]) => [
            id,
            { name: p.name, score: p.score || 0 }
        ])
    );
}

// ✅ WebSocket Events
io.on("connection", socket => {

    // ✅ Player join
    socket.on("join", ({ room, name }) => {
        if (!room || !name) return;

        const code = room.toUpperCase();
        socket.join(code);

        const r = ensureRoom(code);

        r.players.set(socket.id, {
            name,
            score: 0,
            streak: 0
        });

        socket.emit("joined");
        io.to(code).emit("player-joined", { id: socket.id, name });
        io.to(code).emit("scores", roomScores(code));
    });

    // ✅ Host joins a room
    socket.on("host-join", ({ room }) => {
        const code = room.toUpperCase();
        socket.join(code);
        io.to(socket.id).emit("scores", roomScores(code));
    });

    // ✅ Host loads a round
    socket.on("start-from-server", ({ room, round }) => {
        const code = room.toUpperCase();
        const r = ensureRoom(code);

        r.round = round;
        r.qIndex = -1;

        const list = loadQuestions().filter(
            q => normalize(q.round || "") === normalize(round || "")
        );

        io.to(socket.id).emit("server-round-loaded", { count: list.length });
    });

    // ✅ NEXT QUESTION (auto from server)
    socket.on("next-from-server", ({ room }) => {
        const code = room.toUpperCase();
        const r = ensureRoom(code);

        const all = loadQuestions().filter(
            q => normalize(q.round || "") === normalize(r.round || "")
        );

        r.qIndex++;
        if (r.qIndex >= all.length) {
            io.to(code).emit("log", "✅ Plus de questions dans cette manche.");
            return;
        }

        const q = all[r.qIndex];

        // ✅ Save full question
        r.accepting = true;
        r.firstCorrect = null;

        r.question = {
            type: q.type || "mcq",
            text: q.question || "",
            image: q.image || "",
            choices: Array.isArray(q.choices) ? q.choices.filter(Boolean) : [],
            answer: q.answer || "",
            answerImage: q.answerImage || "",
            points: Number(q.points || 10),
            duration: Number(q.duration || 30),
            allowChange: true
        };

        // ✅ Send to players
        io.to(code).emit("question", {
            type: r.question.type,
            text: r.question.text,
            image: r.question.image,
            choices: r.question.choices,
            allowChange: r.question.allowChange,
            duration: r.question.duration
        });

        io.to(code).emit("accepting", true);
    });

    // ✅ Manual question (host)
    socket.on("start-question", q => {
        const code = q.room.toUpperCase();
        const r = ensureRoom(code);

        r.question = {
            type: q.type || "mcq",
            text: q.text || "",
            image: q.image || "",
            choices: Array.isArray(q.choices) ? q.choices.filter(Boolean) : [],
            answer: q.answer || "",
            answerImage: q.answerImage || "",
            points: Number(q.points || 10),
            allowChange: true,
            duration: Number(q.duration || 30)
        };

        r.accepting = true;
        r.firstCorrect = null;

        io.to(code).emit("question", {
            type: r.question.type,
            text: r.question.text,
            image: r.question.image,
            choices: r.question.choices,
            allowChange: true,
            duration: r.question.duration
        });
        io.to(code).emit("accepting", true);
    });

    // ✅ Player answer
    socket.on("answer", ({ room, name, answer }) => {
        const code = room.toUpperCase();
        const r = ensureRoom(code);

        if (!r.accepting || !r.question) return;

        const p = r.players.get(socket.id);
        if (!p) return;

        io.to(code).emit("answer-received", {
            id: socket.id,
            name: p.name,
            answer
        });

        const good = normalize(answer) === normalize(r.question.answer);

        if (good) {
            p.score += r.question.points;

            if (!r.firstCorrect) {
                r.firstCorrect = socket.id;
                p.score += QUICK_BONUS;
            }

            p.streak++;
            if (p.streak >= STREAK_EVERY) {
                p.score += STREAK_BONUS;
                p.streak = 0;
            }
        } else {
            p.streak = 0;
        }

        io.to(code).emit("scores", roomScores(code));
    });

    // ✅ Reveal answer
    socket.on("reveal", ({ room }) => {
        const code = room.toUpperCase();
        const r = ensureRoom(code);

        r.accepting = false;

        io.to(code).emit("accepting", false);
        io.to(code).emit("reveal", {
            answer: r.question?.answer || "",
            answerImage: r.question?.answerImage || ""
        });
        io.to(code).emit("scores", roomScores(code));
    });

});

// ✅ Start server
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () =>
    console.log("✅ QuizCine server listening on port", PORT)
);
