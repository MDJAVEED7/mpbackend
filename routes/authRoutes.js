import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { generateToken } from '../config/jwt.js';

const router = express.Router();

/**
 * REGISTER
 * POST /api/auth/register
 */
router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ message: 'User already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await User.create({
    email,
    password: hashedPassword,
  });

  res.status(201).json({
    token: generateToken(user._id),
    user: {
      _id: user._id,
      email: user.email,
      createdAt: user.createdAt,
    },
  });
});

/**
 * LOGIN
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');
  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  res.json({
    token: generateToken(user._id),
    user: {
      _id: user._id,
      email: user.email,
      createdAt: user.createdAt,
    },
  });
});

export default router;

