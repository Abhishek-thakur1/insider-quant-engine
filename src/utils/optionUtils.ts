export const getBestStrike = (type: "CE" | "PE", currentSpot: number) => {
  // Round to nearest 50 to find the exact ATM strike
  const atmStrike = Math.round(currentSpot / 50) * 50;

  // For scalping, we want ATM or 1 strike ITM for high delta (~0.50 to 0.60)
  // CE ITM means lower strike. PE ITM means higher strike.
  let targetStrike = atmStrike;
  if (type === "CE") {
    targetStrike = atmStrike - 50; // 1 strike ITM for Calls
  } else {
    targetStrike = atmStrike + 50; // 1 strike ITM for Puts
  }

  return {
    strike: targetStrike,
    ltp: 0,
    reason: `Delta ~0.60 ITM`,
  };
};
