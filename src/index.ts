import "dotenv/config";
import express from "express";
import { startBot } from "./bot.js";
import { config } from "./config.js";
import cp2nusRouter from "./routes/cp2nus.js";
import cp2Router from "./routes/cp2.js";

const app = express();
app.use("/cp2nus", cp2nusRouter);
app.use("/", cp2Router);
app.listen(config.server.port, () => {
  console.log(`[server] listening on port ${config.server.port}`);
});

startBot();
