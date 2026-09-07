const fs = require('fs');
const files = ['src/detectors/v2/high_alpha/GapAndGoMomentum.ts', 'src/detectors/v2/high_alpha/VolatilityContraction.ts'];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  fs.writeFileSync(file, content);
}
