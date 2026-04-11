import mongoose from 'mongoose';
import { Visitor } from '../src/models/Visitor.js';
import { ChatSession } from '../src/models/ChatSession.js';

async function debug() {
  try {
    await mongoose.connect('mongodb://localhost:27017/chat-support');
    console.log('Connected to DB');

    const visitors = await Visitor.find({
      $or: [
        { visitorId: /undefined/i },
        { name: /undefined/i },
        { email: /undefined/i }
      ]
    });
    console.log('Visitors with undefined strings:', JSON.stringify(visitors, null, 2));

    const sessions = await ChatSession.find({
      $or: [
        { visitorId: { $in: visitors.map(v => v._id) } },
        { visitorId: /undefined/i }
      ]
    }).populate('visitorId');
    
    console.log('Sessions with possible undefined issues:', JSON.stringify(sessions.map(s => ({
      sessionId: s.sessionId,
      visitorId: s.visitorId?.visitorId,
      visitorName: s.visitorId?.name
    })), null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

debug();
