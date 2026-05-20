import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  executeStandardScan,
  executeVersusScan,
  executeReanalyzeScan,
  executeSkinScan,
} from "../services/scan.service.js";
import { authenticate } from "../middleware/authenticate.js";

interface StandardScanBody {
  base64Image: string;
  scanMode: "food" | "label" | "qr" | "receipt";
}

interface VersusScanBody {
  base64ImageA: string;
  base64ImageB: string;
  scanMode: "versus";
}

interface ReanalyzeScanBody {
  scanMode: "reanalyze";
  manualName: string;
  manualType: "food" | "drink";
  base64Image?: string;
}

interface SkinScanBody {
  scanMode: "skin";
  base64Image: string;
  /** Opsional: 478 landmark points dari MediaPipe Face Landmarker di FE (normalized 0.0-1.0) */
  landmarks?: { x: number; y: number; z: number }[];
}

type ScanBody =
  | StandardScanBody
  | VersusScanBody
  | ReanalyzeScanBody
  | SkinScanBody;

export const scanRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Protect all routes with authentication
  app.addHook("preHandler", authenticate);

  app.post<{ Body: ScanBody }>("/", async (req, reply) => {
    try {
      const payload = req.body;

      if (!payload.scanMode) {
        return reply.status(400).send({ error: "scanMode is required" });
      }

      let aiResult;

      if (payload.scanMode === "versus") {
        const { base64ImageA, base64ImageB } = payload as VersusScanBody;
        if (!base64ImageA || !base64ImageB) {
          return reply.status(400).send({
            error: "base64ImageA and base64ImageB are required for versus mode",
          });
        }
        aiResult = await executeVersusScan(base64ImageA, base64ImageB);
      } else if (payload.scanMode === "skin") {
        const { base64Image, landmarks } = payload as SkinScanBody;
        if (!base64Image) {
          return reply
            .status(400)
            .send({ error: "base64Image is required for skin mode" });
        }
        // Kirim landmarks ke service jika ada (dari MediaPipe FE)
        aiResult = await executeSkinScan(base64Image, landmarks);
      } else if (payload.scanMode === "reanalyze") {
        const { manualName, manualType, base64Image } =
          payload as ReanalyzeScanBody;
        if (!manualName || !manualType) {
          return reply.status(400).send({
            error: "manualName and manualType are required for reanalyze mode",
          });
        }
        aiResult = await executeReanalyzeScan(
          manualName,
          manualType,
          base64Image,
        );
      } else {
        const { base64Image, scanMode } = payload as StandardScanBody;
        if (!base64Image) {
          return reply.status(400).send({ error: "base64Image is required" });
        }
        aiResult = await executeStandardScan(base64Image, scanMode);
      }

      // Format response exactly as frontend expects it, we return the parsed raw data
      // The frontend will save it locally as 'history' items. Later, we can add a 'SAVE' step here to firestore.
      return reply.send({
        success: true,
        data: aiResult,
      });
    } catch (e: any) {
      req.log.error(e, "Error processing AI Scan");
      return reply.status(500).send({
        error: "Failed to process scan using Gemini.",
        details: e.message,
      });
    }
  });
};
