import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import authMiddleware from '../middleware/authMiddleware.js';
import User from '../models/User.js';
import File from '../models/File.js';
import { generateSeedBlock, recoverFromSeed } from '../algorithms/seedBlock.js';
import { splitIntoShards, generateParityShard, encodeRS, recoverRS } from '../algorithms/parity.js';
import cloudinary from 'cloudinary';

// Cloudinary is now configured in index.js (after dotenv.config)

const router = express.Router();

// when using cloudinary, we don't need to persist files locally except for temporary buffer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// helper that uploads a buffer to Cloudinary and returns the result
function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      { resource_type: 'raw', ...options },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/**
 * =========================
 * UPLOAD FILE
 * POST /api/files/upload
 * =========================
 */
router.post(
  '/upload',
  authMiddleware,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      // file data is in memory on req.file.buffer
      const buffer = req.file.buffer;

      // Algorithms
      const seed = generateSeedBlock(buffer);

      // encode shards just as before
      let dataShards = 4;
      let parityShards = 1;
      let shardSize = null;
      let fileSize = buffer.length;
      let shardBuffers = []; // array of {name, buffer}

      try {
        const rs = await encodeRS(buffer, 4, 2);
        dataShards = rs.dataShards;
        parityShards = rs.parityShards;
        shardSize = rs.shardSize;

        rs.shards.forEach((s, i) => {
          shardBuffers.push({ name: `shard_${i}`, buffer: s });
        });
      } catch (e) {
        console.warn('RS encode failed, falling back to XOR parity:', e && e.message ? e.message : e);
        const shards = splitIntoShards(buffer);
        const parity = generateParityShard(shards);

        shardSize = shards[0].length;
        parityShards = 1;
        dataShards = shards.length;

        shards.forEach((s, i) => {
          shardBuffers.push({ name: `shard_${i}`, buffer: s });
        });
        shardBuffers.push({ name: 'parity', buffer: parity });
      }

      // upload primary, seed and shards to Cloudinary under a folder for this file
      const folder = `uploads/${req.user._id}/${Date.now()}`;
      const primaryRes = await uploadBufferToCloudinary(buffer, { folder, public_id: 'primary' });
      const seedRes = await uploadBufferToCloudinary(seed, { folder, public_id: 'seed' });
      const shardUrls = [];
      for (const shard of shardBuffers) {
        const res = await uploadBufferToCloudinary(shard.buffer, { folder, public_id: shard.name });
        shardUrls.push(res.secure_url);
      }

      // Save metadata to MongoDB (store URLs rather than paths)
      const savedFile = await File.create({
        userId: req.user._id,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
        status: 'ACTIVE',
        primaryUrl: primaryRes.secure_url,
        seedUrl: seedRes.secure_url,
        shardUrls,
        dataShards,
        parityShards,
        shardSize,
        fileSize,
      });
      console.log('FILE UPLOADED:', savedFile._id);

      // DB verification: fetch the saved doc and print counts & connection info
      try {
        const found = await File.findById(savedFile._id);
        console.log('DB VERIFY: found saved file:', !!found, found ? found._id : null);
        const count = await File.countDocuments({ userId: req.user._id });
        console.log(`DB VERIFY: files for user ${req.user._id}: ${count}`);
        console.log('MONGO INFO:', {
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name,
          readyState: mongoose.connection.readyState,
        });
      } catch (dbErr) {
        console.error('DB VERIFY ERROR:', dbErr.stack || dbErr);
      }

      return res.status(201).json(savedFile);
    } catch (error) {
      console.error('UPLOAD ERROR:', error.stack || error);
      return res.status(500).json({ message: error.message || 'File upload failed' });
    }
  }
);

/**
 * =========================
 * GET FILES
 * GET /api/files?status=ACTIVE|TRASH
 * =========================
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const query = { userId: req.user._id };

    if (req.query.status && ['ACTIVE', 'TRASH'].includes(req.query.status)) {
      query.status = req.query.status;
    }

    const files = await File.find(query).sort({ createdAt: -1 });
    res.json(files);
  } catch (error) {
    console.error('GET FILES ERROR:', error.stack || error);
    res.status(500).json({ message: error.message || 'Failed to fetch files' });
  }
});

/**
 * =========================
 * MOVE TO TRASH
 * =========================
 */
router.post('/:id/trash', authMiddleware, async (req, res) => {
  try {
    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    file.status = 'TRASH';
    file.deletedAt = new Date();
    await file.save();

    res.json(file);
  } catch (error) {
    console.error('TRASH ERROR:', error.stack || error);
    res.status(500).json({ message: error.message || 'Failed to move file to trash' });
  }
});

/**
 * =========================
 * RESTORE FILE
 * =========================
 */
router.post('/:id/restore', authMiddleware, async (req, res) => {
  try {
    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    // If primary URL exists (Cloudinary), simply restore metadata
    if (file.primaryUrl) {
      file.status = 'ACTIVE';
      file.deletedAt = null;
      await file.save();
      return res.json(file);
    }

    // If local primary path exists (legacy)
    if (file.primaryPath && fs.existsSync(file.primaryPath)) {
      file.status = 'ACTIVE';
      file.deletedAt = null;
      await file.save();
      return res.json(file);
    }

    return res.status(500).json({ message: 'No recovery data available' });
  } catch (error) {
    console.error('RESTORE ERROR:', error.stack || error);
    res.status(500).json({ message: error.message || 'Failed to restore file' });
  }
});

/**
 * =========================
 * DELETE PERMANENTLY
 * =========================
 */
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    console.log('DELETE REQUEST:', { fileId: req.params.id, userId: req.user && req.user._id });

    const file = await File.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!file) {
      console.warn('DELETE: file not found or not owned by user', { fileId: req.params.id, userId: req.user._id });
      return res.status(404).json({ message: 'File not found' });
    }

    // Attempt to remove file artifacts from disk (best-effort)
    try {
      if (file.primaryPath && fs.existsSync(file.primaryPath)) {
        fs.unlinkSync(file.primaryPath);
      }
      if (file.seedPath && fs.existsSync(file.seedPath)) {
        fs.unlinkSync(file.seedPath);
      }
      if (file.shardPath && fs.existsSync(file.shardPath)) {
        // remove shard dir recursively
        fs.rmSync(file.shardPath, { recursive: true, force: true });
      }
      // Also attempt to remove parent dir if empty
      const baseDir = path.dirname(file.primaryPath || '');
      if (baseDir && fs.existsSync(baseDir)) {
        try {
          const entries = fs.readdirSync(baseDir);
          if (entries.length === 0) fs.rmdirSync(baseDir);
        } catch (e) {
          // ignore
        }
      }
      console.log('DELETE: removed files from disk for', file._id);
    } catch (fsErr) {
      console.error('DELETE: failed to clean disk files', fsErr.stack || fsErr);
    }

    res.sendStatus(204);
  } catch (error) {
    console.error('DELETE ERROR:', error.stack || error);
    res.status(500).json({ message: error.message || 'Failed to delete file' });
  }
});


// -------------------------
// DOWNLOAD
// GET /api/files/:id/download?token=<jwt>
// -------------------------
router.get('/:id/download', async (req, res) => {
  try {
    const token = req.query.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    if (!token) return res.status(401).json({ message: 'Not authorized' });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'Not authorized' });

    const file = await File.findOne({ _id: req.params.id, userId: user._id });
    if (!file) return res.status(404).json({ message: 'File not found' });

    // If primary URL exists (Cloudinary), download from it
    if (file.primaryUrl) {
      try {
        const response = await fetch(file.primaryUrl);
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${file.originalName || 'file'}"`);
        return res.send(buffer);
      } catch (err) {
        console.error('DOWNLOAD ERROR (primary URL):', err.stack || err);
      }
    }

    // If local primary path exists (legacy)
    if (file.primaryPath && fs.existsSync(file.primaryPath)) {
      const stat = fs.statSync(file.primaryPath);
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${file.originalName || 'file'}"`);
      return fs.createReadStream(file.primaryPath).pipe(res);
    }

    return res.status(404).json({ message: 'Primary file not found and no recovery data' });
  } catch (error) {
    console.error('DOWNLOAD ERROR:', error.stack || error);
    return res.status(500).json({ message: error.message || 'Download failed' });
  }
});

export default router;
