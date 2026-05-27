import express, { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import { GithubHandlerFunction } from "../interfaces";
import { config } from "../config";
import { logger } from "../logger";
import { isDiscordBootstrapped } from "../discord/discord";
import {
  handleClosed,
  handleCreated,
  handleDeleted,
  handleLabeled,
  handleLocked,
  handleReopened,
  handleUnlabeled,
  handleUnlocked,
} from "./githubHandlers";

declare module "http" {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

function verifyGithubSignature(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const secret = config.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return next();
  }

  const header = req.headers["x-hub-signature-256"];
  const signature = Array.isArray(header) ? header[0] : header;
  if (!signature || !signature.startsWith("sha256=")) {
    logger.warn("webhook signature missing or malformed; rejecting with 401");
    return res.status(401).json({ msg: "invalid signature" });
  }

  const received = signature.slice("sha256=".length);
  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.warn("webhook raw body unavailable; rejecting with 401");
    return res.status(401).json({ msg: "invalid signature" });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(received);
  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    logger.warn("webhook signature mismatch; rejecting with 401");
    return res.status(401).json({ msg: "invalid signature" });
  }

  return next();
}

export function initGithub() {
  if (!config.GITHUB_WEBHOOK_SECRET) {
    logger.warn(
      "GITHUB_WEBHOOK_SECRET is not set; webhook signature verification disabled",
    );
  }

  app.get("", (_, res) => {
    res.json({ msg: "github webhooks work" });
  });

  const githubActions: {
    [key: string]: GithubHandlerFunction;
  } = {
    created: (req) => handleCreated(req),
    closed: (req) => handleClosed(req),
    reopened: (req) => handleReopened(req),
    labeled: (req) => handleLabeled(req),
    unlabeled: (req) => handleUnlabeled(req),
    locked: (req) => handleLocked(req),
    unlocked: (req) => handleUnlocked(req),
    deleted: (req) => handleDeleted(req),
  };

  app.post("/", verifyGithubSignature, (req, res) => {
    if (!isDiscordBootstrapped()) {
      return res.status(503).json({ msg: "discord client not ready" });
    }

    const action = req.body.action;
    const githubAction = githubActions[action];
    if (githubAction) {
      // Fire-and-forget: ack GitHub fast (<10s) instead of blocking on Discord API.
      void Promise.resolve(githubAction(req)).catch((err) => {
        const msg =
          err instanceof Error ? err.stack || err.message : String(err);
        logger.error(`webhook handler "${action}" failed: ${msg}`);
      });
    }
    res.json({ msg: "ok" });
  });

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

export default app;
