// The allowance: a contract that holds the ETH an agent may spend and lets exactly one agent key
// move it, only through execute() and never above a daily cap. Its owner can top it up, change
// the cap and take everything back. When GRID_AGENT_ALLOWANCE names one, this server sends every
// market transaction through it, so the agent key itself holds only the gas money.
//
// This is the part of the contract's interface the server uses, written by hand so the server
// does not depend on how the contract is built.
export const allowanceAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "agent", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "dailyCap", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "remainingToday", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  // Refunds and withdrawals from the markets arrive here.
  { type: "receive", stateMutability: "payable" },
  // Why execute() refuses, so a refusal can be told apart from any other failure.
  { type: "error", name: "CapExceeded", inputs: [] },
  { type: "error", name: "TargetNotAllowed", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "NotAgent", inputs: [] },
] as const;
