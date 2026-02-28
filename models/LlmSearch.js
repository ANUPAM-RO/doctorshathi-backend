import mongoose from "mongoose";

const llmSearchSchema = new mongoose.Schema(
  {
    query: { type: String, required: true, trim: true },
    intent: {
      type: String,
      enum: ["doctor", "hospital", "medicine", "general"],
      default: "general"
    },
    llmContent: { type: String, required: true },
    webResults: [
      {
        title: { type: String, required: true },
        link: { type: String, required: true },
        snippet: { type: String, default: "" },
        source: { type: String, default: "google" }
      }
    ]
  },
  { timestamps: true }
);

llmSearchSchema.index({ query: 1, createdAt: -1 });

export default mongoose.model("LlmSearch", llmSearchSchema);
