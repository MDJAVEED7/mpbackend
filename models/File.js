import mongoose from 'mongoose';

const fileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  filename: String,
  originalName: String,
  size: Number,
  mimeType: String,
  status: {
    type: String,
    enum: ['ACTIVE', 'TRASH', 'DELETED'],
    default: 'ACTIVE',
  },
  // local paths (kept for backwards compatibility)
  primaryPath: String,
  seedPath: String,
  shardPath: String,

  // cloudinary URLs / public IDs
  primaryUrl: String,
  seedUrl: String,
  shardUrls: [String],

  dataShards: Number,
  parityShards: Number,
  shardSize: Number,
  fileSize: Number,
  deletedAt: Date,
}, { timestamps: true });

export default mongoose.model('File', fileSchema);
