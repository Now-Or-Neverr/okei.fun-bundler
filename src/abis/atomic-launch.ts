export const okeiAtomicLaunchAbi = [
  {
    type: 'constructor',
    inputs: [{name: 'factory_', type: 'address', internalType: 'address'}],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'factory',
    inputs: [],
    outputs: [{name: '', type: 'address', internalType: 'contract IOkeiFactory'}],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{name: '', type: 'address', internalType: 'address'}],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'launch',
    inputs: [
      {name: 'name', type: 'string', internalType: 'string'},
      {name: 'symbol', type: 'string', internalType: 'string'},
      {name: 'metadataURI', type: 'string', internalType: 'string'},
      {
        name: 'venue',
        type: 'uint8',
        internalType: 'enum IOkeiFactory.Venue',
      },
      {name: 'minTokensOutFirst', type: 'uint256', internalType: 'uint256'},
      {name: 'beneficiary', type: 'address', internalType: 'address'},
      {
        name: 'extras',
        type: 'tuple[]',
        internalType: 'struct OkeiAtomicLaunch.ExtraBuy[]',
        components: [
          {name: 'usdcIn', type: 'uint256', internalType: 'uint256'},
          {name: 'minTokensOut', type: 'uint256', internalType: 'uint256'},
          {name: 'recipient', type: 'address', internalType: 'address'},
        ],
      },
      {name: 'deadline', type: 'uint256', internalType: 'uint256'},
    ],
    outputs: [
      {name: 'token', type: 'address', internalType: 'address'},
      {name: 'curve', type: 'address', internalType: 'address'},
    ],
    stateMutability: 'payable',
  },
  {
    type: 'event',
    name: 'Launched',
    inputs: [
      {name: 'beneficiary', type: 'address', indexed: true, internalType: 'address'},
      {name: 'token', type: 'address', indexed: false, internalType: 'address'},
      {name: 'curve', type: 'address', indexed: false, internalType: 'address'},
      {name: 'extraLegs', type: 'uint256', indexed: false, internalType: 'uint256'},
    ],
  },
] as const;
