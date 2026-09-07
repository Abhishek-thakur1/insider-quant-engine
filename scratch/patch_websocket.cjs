const fs = require('fs');
let text = fs.readFileSync('src/ingestion/websocket.ts', 'utf8');
text = text.replace("import { GapAndGoMomentum } from '../detectors/v2/high_alpha/GapAndGoMomentum.js'\r\n", "");
text = text.replace("import { GapAndGoMomentum } from '../detectors/v2/high_alpha/GapAndGoMomentum.js'\n", "");
text = text.replace("\t\t\t\tnew GapAndGoMomentum(symbol),\r\n", "");
text = text.replace("\t\t\t\tnew GapAndGoMomentum(symbol),\n", "");
fs.writeFileSync('src/ingestion/websocket.ts', text);
