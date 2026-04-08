import fs from "fs";
import path from "path";

const LOG_PATH = path.resolve(process.cwd(), "logs/shadow_trades.csv");

// Create the directory and header if they don't exist
if (!fs.existsSync(path.dirname(LOG_PATH))) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
}

if (!fs.existsSync(LOG_PATH)) {
  const header = "timestamp,strategy,symbol,side,price,vwap,status,reason\n";
  fs.writeFileSync(LOG_PATH, header);
}

export const logShadowTrade = (data: {
  strategy: string;
  symbol: string;
  side: "LONG" | "SHORT";
  price: number;
  vwap: number;
  status: "FIRED" | "NEAR_MISS";
  reason: string;
}) => {
  const timestamp = new Date().toISOString();
  const row = `${timestamp},${data.strategy},${data.symbol},${data.side},${data.price},${data.vwap},${data.status},"${data.reason.replace(/"/g, "")}"\n`;

  // Append to file asynchronously so we don't lag the websocket
  fs.appendFile(LOG_PATH, row, (err) => {
    if (err) console.error("❌ Shadow Logger Error:", err);
  });
};
