const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/', (req,res)=> res.send('Quiz Cine WS OK'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

const rooms = {};

io.on('connection', (socket)=>{
  socket.on('join', ({room, name})=>{
    room = (room||'').toUpperCase();
    if(!room) return;
    socket.join(room);
    if(!rooms[room]) rooms[room] = { players:{}, accepting:false, current:null };
    if(!rooms[room].players[name]) rooms[room].players[name] = { name, score:0, answer:null };
    socket.emit('joined', true);
    io.to(room).emit('player-joined', {name});
    io.to(room).emit('room-info', {scores: rooms[room].players});
  });

  socket.on('host-join', ({room})=>{
    room = (room||'').toUpperCase();
    socket.join(room);
    if(!rooms[room]) rooms[room] = { players:{}, accepting:false, current:null };
    socket.emit('room-info', {scores: rooms[room].players});
  });

  socket.on('start-question', (q)=>{
    const room = (q.room||'').toUpperCase();
    if(!room) return;
    if(!rooms[room]) rooms[room] = { players:{}, accepting:false, current:null };
    rooms[room].accepting = true;
    rooms[room].current = { text:q.text, image:q.image, choices:q.choices, answer:q.answer, points:q.points, allowChange: !!q.allowChange };
    Object.values(rooms[room].players).forEach(p=> p.answer=null);
    io.to(room).emit('question', rooms[room].current);
    io.to(room).emit('accepting', true);
  });

  socket.on('answer', ({room, name, answer})=>{
    room = (room||'').toUpperCase();
    if(!room || !rooms[room] || !rooms[room].accepting) return;
    const R = rooms[room];
    if(!R.players[name]) R.players[name]={name, score:0, answer:null};
    R.players[name].answer = answer;
    io.to(room).emit('answer-received', {name, answer});
  });

  socket.on('reveal', ({room})=>{
    room = (room||'').toUpperCase();
    if(!room || !rooms[room]) return;
    const R = rooms[room];
    if(!R.current) return;
    R.accepting = false;
    const correct = (R.current.answer||'').trim().toLowerCase();
    Object.values(R.players).forEach(p=>{
      if((p.answer||'').trim().toLowerCase() === correct){
        p.score += Number(R.current.points||0);
      }
    });
    io.to(room).emit('accepting', false);
    io.to(room).emit('reveal', {answer: R.current.answer});
    io.to(room).emit('scores', R.players);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=> console.log('Quiz Cine WS listening on', PORT));
