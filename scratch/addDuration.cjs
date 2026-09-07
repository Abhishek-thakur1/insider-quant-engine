const fs = require('fs');
const files = [
  'src/detectors/v2/high_alpha/GapAndGoMomentum.ts',
  'src/detectors/v2/high_alpha/VolatilityContraction.ts',
  'src/detectors/v2/stockMomentumBreakoutDetector.ts'
];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/regimeClass: 'MOMENTUM',/g, "regimeClass: 'MOMENTUM',\n\t\t\t\tdurationClass: 'SWING',");
  fs.writeFileSync(file, content);
}
console.log('done duration');
