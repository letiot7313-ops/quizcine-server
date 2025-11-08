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
const loadQuestions = ()=>{
  try{
    const raw = fs.readFileSync(QUESTIONS_PATH, "utf-8");
    const obj = JSON.parse(raw);
    return Array.isArray(obj.questions) ? obj.questions : (Array.isArray(obj)? obj : []);
  }catch(e){ return []; }
};

app.get("/", (_req,res)=> res.send("QuizCine Server OK"));
app.get("/questions", (_req,res)=> res.json({ questions: loadQuestions() }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET","POST"] } });

const rooms = new Map();
const norm  = s => s.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const STREAK_EVERY = 3, STREAK_BONUS = 5, QUICK_BONUS = 5;

const ensureRoom = code => {
  if(!rooms.has(code)){
    rooms.set(code, { players:new Map(), accepting:false, question:null, firstCorrect:null, qIndex:-1, round:"" });
  }
  return rooms.get(code);
};
const roomScores = code => {
  const r = ensureRoom(code);
  return Object.fromEntries([...r.players.entries()].map(([sid,p])=>[sid,{name:p.name, score:p.score|0}]));
};

io.on("connection", (socket)=>{
  socket.on("join", ({room,name})=>{
    if(!room||!name) return;
    const code=room.toUpperCase();
    socket.join(code);
    const r = ensureRoom(code);
    r.players.set(socket.id, {name, score:0, streak:0});
    socket.emit("joined");
    io.to(code).emit("player-joined",{id:socket.id,name});
    io.to(code).emit("room-info",{scores:roomScores(code)});
  });

  socket.on("host-join", ({room})=>{
    if(!room) return;
    const code=room.toUpperCase();
    socket.join(code);
    io.to(socket.id).emit("room-info",{scores:roomScores(code)});
  });

  socket.on("start-from-server", ({room,round})=>{
    const code=(room||"").toUpperCase();
    const r = ensureRoom(code);
    r.round  = round||""; r.qIndex=-1;
    const list = loadQuestions().filter(q => (q.round||"").toLowerCase().trim() === (r.round||"").toLowerCase().trim());
    io.to(socket.id).emit("server-round-loaded", {count:list.length});
  });

  socket.on("next-from-server", ({room})=>{
    const code=(room||"").toUpperCase();
    const r = ensureRoom(code);
    const list = loadQuestions().filter(q => (q.round||"").toLowerCase().trim() === (r.round||"").toLowerCase().trim());
    r.qIndex = Math.min(r.qIndex+1, list.length-1);
    const q = list[r.qIndex];
    if(!q){ io.to(code).emit("log","No more questions."); return; }
    r.accepting=true; r.question=q; r.firstCorrect=null;
    io.to(code).emit("question", {
      type:(q.type||"mcq"),
      text:q.question||"",
      image:q.image||"",
      choices:Array.isArray(q.choices)? q.choices:[],
      allowChange:true,
      duration:Number(q.duration||30)
    });
    io.to(code).emit("accepting",true);
  });

  socket.on("start-question", (q)=>{
    if(!q||!q.room) return;
    const code=q.room.toUpperCase();
    const r=ensureRoom(code);
    r.question = {
      type:(q.type||"mcq"), text:q.text||"", image:q.image||"",
      choices:Array.isArray(q.choices)? q.choices.filter(Boolean).slice(0,4):[],
      answer:q.answer||"", points:Number(q.points||10), allowChange:!!q.allowChange
    };
    r.accepting=true; r.firstCorrect=null;
    io.to(code).emit("question", { type:r.question.type, text:r.question.text, image:r.question.image, choices:r.question.choices, allowChange:r.question.allowChange });
    io.to(code).emit("accepting",true);
  });

  socket.on("answer", ({room, name, answer})=>{
    if(!room) return;
    const code=room.toUpperCase();
    const r=ensureRoom(code);
    if(!r.accepting||!r.question) return;
    const p=r.players.get(socket.id); if(!p) return;
    io.to(code).emit("answer-received",{id:socket.id,name:p.name,answer});
    const corr = norm(r.question.answer||"");
    const ok = norm(answer)===corr;
    if(ok){
      p.score=(p.score||0)+(r.question.points||0);
      if(!r.firstCorrect){ r.firstCorrect=socket.id; p.score+=QUICK_BONUS; }
      p.streak=(p.streak||0)+1; if(p.streak>=STREAK_EVERY){ p.score+=STREAK_BONUS; p.streak=0; }
    } else {
      p.streak=0;
    }
    io.to(code).emit("scores", roomScores(code));
  });

  socket.on("reveal", ({room})=>{
    if(!room) return;
    const code=room.toUpperCase();
    const r=ensureRoom(code);
    r.accepting=false;
    io.to(code).emit("accepting",false);
    io.to(code).emit("reveal",{
      answer:(r.question&&r.question.answer)||"",
      answerImage:(r.question&&r.question.answerImage)||""
    });
    io.to(code).emit("scores", roomScores(code));
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, ()=> console.log("QuizCine server listening on", PORT));
