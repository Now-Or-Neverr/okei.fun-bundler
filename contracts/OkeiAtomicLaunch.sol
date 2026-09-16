// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One tx: OkeiFactory.createToken (deploy + dev buy) + N curve buys.
/// @dev Lives in the bundler repo only — no okei.fun contract changes.
///      `createToken` sees this contract as msg.sender, so OkeiToken.creator is this address.
///      Opening-buy tokens are forwarded to `beneficiary`; extra buys mint to each leg recipient.
interface IOkeiFactory {
    enum Venue {
        OkeiSwap,
        Uniswap
    }

    function creationFee() external view returns (uint256);

    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        Venue venue,
        uint256 minTokensOut,
        uint256 deadline
    ) external payable returns (address token, address curve, uint256 tokensOut);
}

interface IOkeiCurve {
    function buy(uint256 minTokensOut, address to, uint256 deadline)
        external
        payable
        returns (uint256 tokensOut);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);
}

contract OkeiAtomicLaunch {
    IOkeiFactory public immutable factory;
    address public owner;

    struct ExtraBuy {
        uint256 usdcIn;
        uint256 minTokensOut;
        address recipient;
    }

    error NotOwner();
    error WrongValue();
    error ZeroBeneficiary();
    error ZeroRecipient();
    error TransferFailed();

    event Launched(
        address indexed beneficiary,
        address token,
        address curve,
        uint256 extraLegs
    );

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroBeneficiary();
        factory = IOkeiFactory(factory_);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroBeneficiary();
        owner = newOwner;
    }

    /// @param beneficiary Receives dev-buy tokens and any USDC refunds from the factory/curve.
    /// @param extras Additional buys on the new curve after createToken returns.
    function launch(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        IOkeiFactory.Venue venue,
        uint256 minTokensOutFirst,
        address beneficiary,
        ExtraBuy[] calldata extras,
        uint256 deadline
    ) external payable onlyOwner returns (address token, address curve) {
        if (beneficiary == address(0)) revert ZeroBeneficiary();

        uint256 fee = factory.creationFee();
        uint256 extrasTotal;
        for (uint256 i = 0; i < extras.length; i++) {
            if (extras[i].recipient == address(0)) revert ZeroRecipient();
            extrasTotal += extras[i].usdcIn;
        }

        uint256 firstBuy = msg.value - fee - extrasTotal;
        if (msg.value != fee + firstBuy + extrasTotal) revert WrongValue();

        (token, curve,) = factory.createToken{value: fee + firstBuy}(
            name, symbol, metadataURI, venue, minTokensOutFirst, deadline
        );

        uint256 openingTokens = IERC20(token).balanceOf(address(this));
        if (openingTokens != 0) {
            if (!IERC20(token).transfer(beneficiary, openingTokens)) revert TransferFailed();
        }

        IOkeiCurve curveContract = IOkeiCurve(curve);
        for (uint256 i = 0; i < extras.length; i++) {
            ExtraBuy calldata leg = extras[i];
            curveContract.buy{value: leg.usdcIn}(leg.minTokensOut, leg.recipient, deadline);
        }

        uint256 usdcLeft = address(this).balance;
        if (usdcLeft != 0) {
            (bool ok,) = payable(beneficiary).call{value: usdcLeft}("");
            if (!ok) revert TransferFailed();
        }

        emit Launched(beneficiary, token, curve, extras.length);
    }

    receive() external payable {}
}
