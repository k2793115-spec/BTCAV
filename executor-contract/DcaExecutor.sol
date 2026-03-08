// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

contract DcaExecutor {
    error NotOwner();
    error NotAuthorizedCaller();
    error AmountInTooHigh();
    error DeadlineTooFar();
    error DeadlineExpired();
    error IntervalNotMet();
    error SlippageTooLoose();
    error InvalidRecipient();
    error InvalidQuote();
    error TokenTransferFailed();
    error TokenApproveFailed();

    event Executed(
        address indexed caller,
        uint256 amountIn,
        uint256 quotedAmountOut,
        uint256 minAmountOut,
        uint256 actualAmountOut,
        uint256 timestamp
    );

    event OwnerUpdated(address indexed newOwner);
    event AuthorizedCallerUpdated(address indexed newAuthorizedCaller);
    event RecipientUpdated(address indexed newRecipient);
    event MaxAmountInUpdated(uint256 newMaxAmountIn);
    event MaxSlippageBpsUpdated(uint256 newMaxSlippageBps);
    event MinIntervalUpdated(uint256 newMinInterval);
    event MaxDeadlineDelayUpdated(uint256 newMaxDeadlineDelay);

    address public owner;
    address public authorizedCaller;

    address public immutable router;
    address public immutable tokenIn;
    address public immutable tokenOut;
    uint24 public immutable poolFee;

    address public recipient;

    uint256 public maxAmountIn;
    uint256 public maxSlippageBps;
    uint256 public minInterval;
    uint256 public maxDeadlineDelay;

    uint256 public lastExecutedAt;

    constructor(
        address _owner,
        address _authorizedCaller,
        address _router,
        address _tokenIn,
        address _tokenOut,
        uint24 _poolFee,
        address _recipient,
        uint256 _maxAmountIn,
        uint256 _maxSlippageBps,
        uint256 _minInterval,
        uint256 _maxDeadlineDelay
    ) {
        owner = _owner;
        authorizedCaller = _authorizedCaller;
        router = _router;
        tokenIn = _tokenIn;
        tokenOut = _tokenOut;
        poolFee = _poolFee;
        recipient = _recipient;
        maxAmountIn = _maxAmountIn;
        maxSlippageBps = _maxSlippageBps;
        minInterval = _minInterval;
        maxDeadlineDelay = _maxDeadlineDelay;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAuthorizedCaller() {
        if (msg.sender != authorizedCaller) revert NotAuthorizedCaller();
        _;
    }

    function executeDca(
        uint256 amountIn,
        uint256 quotedAmountOut,
        uint256 minAmountOut,
        uint256 deadline
    ) external onlyAuthorizedCaller returns (uint256 amountOut) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (quotedAmountOut == 0 || minAmountOut == 0) revert InvalidQuote();
        if (amountIn > maxAmountIn) revert AmountInTooHigh();
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (deadline > block.timestamp + maxDeadlineDelay) revert DeadlineTooFar();
        if (block.timestamp < lastExecutedAt + minInterval) revert IntervalNotMet();

        // minAmountOut が緩すぎないことを強制
        // 例: maxSlippageBps = 100 なら 1% まで
        // minAmountOut >= quotedAmountOut * (10000 - maxSlippageBps) / 10000
        if (minAmountOut * 10_000 < quotedAmountOut * (10_000 - maxSlippageBps)) {
            revert SlippageTooLoose();
        }

        _forceApprove(tokenIn, router, amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter
            .ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: recipient,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            });

        amountOut = ISwapRouter(router).exactInputSingle(params);

        lastExecutedAt = block.timestamp;

        emit Executed(
            msg.sender,
            amountIn,
            quotedAmountOut,
            minAmountOut,
            amountOut,
            block.timestamp
        );
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    function setAuthorizedCaller(address newAuthorizedCaller) external onlyOwner {
        authorizedCaller = newAuthorizedCaller;
        emit AuthorizedCallerUpdated(newAuthorizedCaller);
    }

    function setRecipient(address newRecipient) external onlyOwner {
        recipient = newRecipient;
        emit RecipientUpdated(newRecipient);
    }

    function setMaxAmountIn(uint256 newMaxAmountIn) external onlyOwner {
        maxAmountIn = newMaxAmountIn;
        emit MaxAmountInUpdated(newMaxAmountIn);
    }

    function setMaxSlippageBps(uint256 newMaxSlippageBps) external onlyOwner {
        maxSlippageBps = newMaxSlippageBps;
        emit MaxSlippageBpsUpdated(newMaxSlippageBps);
    }

    function setMinInterval(uint256 newMinInterval) external onlyOwner {
        minInterval = newMinInterval;
        emit MinIntervalUpdated(newMinInterval);
    }

    function setMaxDeadlineDelay(uint256 newMaxDeadlineDelay) external onlyOwner {
        maxDeadlineDelay = newMaxDeadlineDelay;
        emit MaxDeadlineDelayUpdated(newMaxDeadlineDelay);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        bool ok = IERC20(token).transfer(to, amount);
        if (!ok) revert TokenTransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        bool ok = IERC20(token).approve(spender, 0);
        if (!ok) revert TokenApproveFailed();

        ok = IERC20(token).approve(spender, amount);
        if (!ok) revert TokenApproveFailed();
    }
}