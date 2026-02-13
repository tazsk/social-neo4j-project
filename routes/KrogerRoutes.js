// backend/routes/KrogerRoutes.js
import express from "express";
import multer from "multer";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/AuthMiddleware.js";
import {
  krogerSearch,
  krogerSearchStream,
  krogerCartAddStream,
  krogerFridgeUpload, // ✅ NEW
  krogerTestEval,
} from "../controllers/KrogerController.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6MB
});

// JSON
router.post("/search", authMiddleware, krogerSearch);

// SSE search stream
router.get("/search/stream", optionalAuthMiddleware, krogerSearchStream);

// SSE add-to-cart stream
router.get("/cart/add/stream", optionalAuthMiddleware, krogerCartAddStream);

// ✅ NEW: fridge photo upload (requires auth)
router.post("/fridge/upload", authMiddleware, upload.single("image"), krogerFridgeUpload);

router.get("/test/eval", optionalAuthMiddleware, krogerTestEval);

export default router;
