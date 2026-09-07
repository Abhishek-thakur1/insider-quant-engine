const fs = require('fs');
let text = fs.readFileSync('backtest/registry.ts', 'utf8');
text = text.replace("import { GapAndGoMomentum } from '../src/detectors/v2/high_alpha/GapAndGoMomentum.js'", "import { GapAndGoMomentum } from '../src/detectors/deprecated/GapAndGoMomentum.js'");
fs.writeFileSync('backtest/registry.ts', text);
