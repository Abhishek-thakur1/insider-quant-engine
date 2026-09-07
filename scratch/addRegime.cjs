const fs = require('fs');

const mapping = {
  'src/detectors/v2/niftyTrendPulseDetector.ts': 'MOMENTUM',
  'src/detectors/v2/niftyVwapReclaimDetector.ts': 'REVERSION',
  'src/detectors/v2/niftyOpeningRangeExplosionDetector.ts': 'MOMENTUM',
  'src/detectors/deltahedgingpressuredetector.ts': 'UNIVERSAL',
  'src/detectors/v2/stockMomentumBreakoutDetector.ts': 'MOMENTUM'
};

for (const [file, regime] of Object.entries(mapping)) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/sendTelegramAlert\(\{/g, `sendTelegramAlert({\n\t\t\tregimeClass: '${regime}',\n\t\t\tdetectorName: this.name || 'Unknown',`);
  fs.writeFileSync(file, content);
}
console.log('done');
