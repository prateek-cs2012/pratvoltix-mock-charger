import mongoose, { Schema, type InferSchemaType } from "mongoose";

const chargePointSchema = new Schema(
  {
    identity: { type: String, required: true, unique: true, index: true },
    ocppVersion: { type: String, required: true, default: "1.6" },
    vendor: String,
    model: String,
    serialNumber: String,
    firmwareVersion: String,
    status: {
      type: String,
      required: true,
      enum: ["connected", "disconnected"],
      default: "disconnected",
    },
    connectorStatus: String,
    lastSeenAt: Date,
    lastBootAt: Date,
    heartbeatInterval: Number,
    activeTransactionId: Number,
  },
  { timestamps: true },
);

export type ChargePointRecord = InferSchemaType<typeof chargePointSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const ChargePointModel = mongoose.model("ChargePoint", chargePointSchema);
