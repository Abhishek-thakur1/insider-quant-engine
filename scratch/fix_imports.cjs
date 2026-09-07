const fs = require('fs');
let text = fs.readFileSync('src/detectors/deprecated/GapAndGoMomentum.ts', 'utf8');
text = text.replace(/..\/..\/..\/config\//g, '../../config/');
text = text.replace(/..\/..\/..\/core\//g, '../../core/');
text = text.replace(/..\/..\/..\/utils\//g, '../../utils/');
text = text.replace(/..\/..\/..\/workers\//g, '../../workers/');
text = text.replace(/'\.\/baseDetector\.js'/g, "'../v2/high_alpha/baseDetector.js'");
fs.writeFileSync('src/detectors/deprecated/GapAndGoMomentum.ts', text);
