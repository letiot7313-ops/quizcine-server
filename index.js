import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("QuizCine Server OK"));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

const rooms = new Map(); // roomCode -> { players: Map(socketId->{name,score,streak}), accepting, question, firstCorrect }

const norm = (s="") => s.toString().trim().toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const STREAK_EVERY = 3;
const STREAK_BONUS = 5;
const QUICK_BONUS = 5;

function ensureRoom(code){
  if(!rooms.has(code)){
    rooms.set(code, {
      players: new Map(),
      accepting: false,
      question: null,
      firstCorrect: null,
    });
  }
  return rooms.get(code);
}

function scoresObj(room){
  const r = ensureRoom(room);
  const obj = {};
  for(const [sid,p] of r.players){
    obj[sid] = { name: p.name, score: p.score|0 };
  }
  return obj;
}

io.on("connection", (socket)=>{
  socket.on("join", ({room, name})=>{
    if(!room || !name) return;
    const code = room.toUpperCase();
    socket.join(code);
    const r = ensureRoom(code);
    r.players.set(socket.id, { name, score: 0, streak: 0 });
    socket.emit("joined");
    io.to(code).emit("player-joined", { id: socket.id, name });
    io.to(code).emit("room-info", { scores: scoresObj(code) });
  });

  socket.on("host-join", ({room})=>{
    if(!room) return;
    const code = room.toUpperCase();
    socket.join(code);
    io.to(socket.id).emit("room-info", { scores: scoresObj(code) });
  });

  socket.on("start-question", (q)=>{
    if(!q || !q.room) return;
    const code = q.room.toUpperCase();
    const r = ensureRoom(code);
    r.question = {
      type: (q.type||"mcq"),
      text: q.text||"",
      image: q.image||"",
      choices: Array.isArray(q.choices)? q.choices.filter(Boolean).slice(0,4) : [],
      answer: q.answer||"",
      points: Number(q.points||10),
      allowChange: !!q.allowChange
    };
    r.accepting = true;
    r.firstCorrect = null;
    io.to(code).emit("question", {
      type: r.question.type,
      text: r.question.text,
      image: r.question.image,
      choices: r.question.choices,
      allowChange: r.question.allowChange
    });
    io.to(code).emit("accepting", true);
  });

  socket.on("answer", ({room, name, answer})=>{
    if(!room) return;
    const code = room.toUpperCase();
    const r = ensureRoom(code);
    if(!r.accepting || !r.question) return;
    const player = r.players.get(socket.id);
    if(!player) return;
    io.to(code).emit("answer-received", { id: socket.id, name: player.name, answer });
    const q = r.question;
    const corr = norm(q.answer);
    let isCorrect = false;
    if(q.type === "mcq"){
      if(norm(answer) === corr) isCorrect = true;
    }else{
      if(norm(answer) === corr) isCorrect = true;
    }
    if(isCorrect){
      player.score = (player.score||0) + (q.points||0);
      if(!r.firstCorrect){
        r.firstCorrect = socket.id;
        player.score += QUICK_BONUS;
      }
      player.streak = (player.streak||0) + 1;
      if(player.streak >= STREAK_EVERY){
        player.score += STREAK_BONUS;
        player.streak = 0;
      }
    } else {
      player.streak = 0;
    }
    io.to(code).emit("scores", Object.fromEntries(
      Array.from(r.players.entries()).map(([sid,p])=>[sid,{name:p.name, score:p.score|0}])
    ));
  });

  socket.on("reveal", ({room})=>{
    if(!room) return;
    const code = room.toUpperCase();
    const r = ensureRoom(code);
    r.accepting = false;
    io.to(code).emit("accepting", false);
    io.to(code).emit("reveal");
    io.to(code).emit("scores", Object.fromEntries(
      Array.from(r.players.entries()).map(([sid,p])=>[sid,{name:p.name, score:p.score|0}])
    ));
  });

  socket.on("disconnect", ()=>{
    for(const [code, r] of rooms){
      if(r.players.delete(socket.id)){
        io.to(code).emit("room-info", { scores: scoresObj(code) });
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, ()=>{
  console.log("QuizCine server listening on", PORT);
});
