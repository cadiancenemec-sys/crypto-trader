// Calculate target price based on desired profit
function calculateTargetFromProfit() {
  const ethAmount = parseFloat(document.getElementById('specialEthAmount').value);
  const currentPrice = parseFloat(document.getElementById('currentPriceDisplay').textContent) || 0;
  const profitInput = parseFloat(document.getElementById('takeProfitPrice').value);
  const resultSpan = document.getElementById('targetPriceResult');
  
  if (!ethAmount || !currentPrice || !profitInput) {
    if (resultSpan) resultSpan.textContent = '';
    return;
  }
  
  // Target price = current price + (desired profit / ETH amount)
  const targetPrice = currentPrice + (profitInput / ethAmount);
  const percentGain = ((targetPrice - currentPrice) / currentPrice * 100).toFixed(2);
  
  if (resultSpan) {
    resultSpan.innerHTML = `
      <div style="margin-top: 8px; padding: 8px; background: rgba(0, 255, 136, 0.1); border-radius: 4px; font-size: 0.85em;">
        <strong style="color: #00ff88;">🎯 Target Price:</strong> $${targetPrice.toFixed(2)}<br>
        <span style="color: #aaa;">(${percentGain}% gain)</span>
      </div>
    `;
  }
}
