// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TermulInvoices} from "../src/TermulInvoices.sol";

interface TermulVm {
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 errorSelector) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

contract CallbackMerchant {
    TermulInvoices private immutable TARGET;
    bytes32 private immutable INVOICE_ID;
    bytes32 private immutable OTHER_INVOICE_ID;
    bytes4 public callbackError;

    constructor(TermulInvoices invoices, bytes32 id, bytes32 otherId) {
        TARGET = invoices;
        INVOICE_ID = id;
        OTHER_INVOICE_ID = otherId;
    }

    function open(uint256 amount) external {
        TARGET.createInvoice(INVOICE_ID, amount, 0);
        TARGET.createInvoice(OTHER_INVOICE_ID, amount, 0);
    }

    receive() external payable {
        try TARGET.payInvoice{value: msg.value}(address(this), OTHER_INVOICE_ID) {
            revert("cross-invoice reentrancy succeeded");
        } catch (bytes memory reason) {
            require(reason.length == 4, "unexpected callback error length");
            // forge-lint: disable-next-line(unsafe-typecast)
            callbackError = bytes4(reason);
        }
    }
}

contract TermulInvoicesTest {
    TermulVm private constant VM = TermulVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant MERCHANT = address(0xA11CE);
    address private constant PAYER = address(0xB0B);
    bytes32 private constant ID = keccak256("termul-invoice");
    bytes32 private constant OTHER_ID = keccak256("termul-other-invoice");
    // Includes precision beyond the six-decimal ERC-20 USDC interface.
    uint256 private constant AMOUNT = 12_500_000_000_000_000_001;

    TermulInvoices private invoices;

    event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiresAt);
    event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount);
    event InvoiceCancelled(bytes32 indexed invoiceId, address indexed merchant);

    function setUp() public {
        invoices = new TermulInvoices();
        VM.deal(PAYER, 100 ether);
    }

    function testCreationAndExactPaymentEventsAndBalances() public {
        uint64 expiry = uint64(block.timestamp + 100);
        VM.expectEmit(true, true, false, true, address(invoices));
        emit InvoiceCreated(ID, MERCHANT, AMOUNT, expiry);
        _create(MERCHANT, expiry);

        uint256 merchantBefore = MERCHANT.balance;
        uint256 payerBefore = PAYER.balance;
        VM.warp(expiry - 1);
        VM.expectEmit(true, true, true, true, address(invoices));
        emit InvoicePaid(ID, MERCHANT, PAYER, AMOUNT);
        _pay(MERCHANT, AMOUNT);

        TermulInvoices.Invoice memory invoice = invoices.getInvoice(MERCHANT, ID);
        require(invoice.merchant == MERCHANT && invoice.amount == AMOUNT && invoice.expiresAt == expiry);
        require(invoice.status == TermulInvoices.InvoiceStatus.Paid);
        require(MERCHANT.balance == merchantBefore + AMOUNT && PAYER.balance == payerBefore - AMOUNT);
        require(address(invoices).balance == 0);
    }

    function testZeroAmountAndZeroIdRejected() public {
        VM.expectRevert(TermulInvoices.InvalidAmount.selector);
        invoices.createInvoice(ID, 0, 0);
        VM.expectRevert(TermulInvoices.InvalidInvoiceId.selector);
        invoices.createInvoice(bytes32(0), AMOUNT, 0);
    }

    function testUnderpaymentAndOverpaymentRejected() public {
        _create(MERCHANT, 0);
        VM.expectRevert(TermulInvoices.WrongAmount.selector);
        _pay(MERCHANT, AMOUNT - 1);
        VM.expectRevert(TermulInvoices.WrongAmount.selector);
        _pay(MERCHANT, AMOUNT + 1);
        require(invoices.getInvoice(MERCHANT, ID).status == TermulInvoices.InvoiceStatus.Open);
    }

    function testExpiryAtExactTimestamp() public {
        VM.warp(1000);
        VM.expectRevert(TermulInvoices.InvalidExpiry.selector);
        _create(MERCHANT, 1000);
        _create(MERCHANT, 1001);
        VM.warp(1001);
        VM.expectRevert(TermulInvoices.InvoiceExpired.selector);
        _pay(MERCHANT, AMOUNT);
    }

    function testUnauthorizedCancellationAndCancelledInvoice() public {
        _create(MERCHANT, 0);
        VM.expectRevert(TermulInvoices.NotMerchant.selector);
        VM.prank(PAYER);
        invoices.cancelInvoice(MERCHANT, ID);
        VM.expectEmit(true, true, false, false, address(invoices));
        emit InvoiceCancelled(ID, MERCHANT);
        VM.prank(MERCHANT);
        invoices.cancelInvoice(MERCHANT, ID);

        VM.expectRevert(TermulInvoices.InvoiceNotOpen.selector);
        _pay(MERCHANT, AMOUNT);
        require(invoices.getInvoice(MERCHANT, ID).status == TermulInvoices.InvoiceStatus.Cancelled);
    }

    function testSecondPaymentAndCancellationAfterPaymentRejected() public {
        _create(MERCHANT, 0);
        _pay(MERCHANT, AMOUNT);
        uint256 merchantBalance = MERCHANT.balance;
        VM.expectRevert(TermulInvoices.InvoiceNotOpen.selector);
        _pay(MERCHANT, AMOUNT);
        VM.expectRevert(TermulInvoices.InvoiceNotOpen.selector);
        VM.prank(MERCHANT);
        invoices.cancelInvoice(MERCHANT, ID);
        require(MERCHANT.balance == merchantBalance);
    }

    function testDuplicateIdIsolatedByMerchantAndCannotBeReused() public {
        _create(MERCHANT, 0);
        address other = address(0xCAFE);
        _create(other, 0);
        _pay(MERCHANT, AMOUNT);
        require(invoices.getInvoice(other, ID).status == TermulInvoices.InvoiceStatus.Open);
        VM.expectRevert(TermulInvoices.InvoiceAlreadyExists.selector);
        _create(MERCHANT, 0);
        _pay(other, AMOUNT);
        require(invoices.getInvoice(other, ID).status == TermulInvoices.InvoiceStatus.Paid);
    }

    function testRejectedMerchantTransferRollsBack() public {
        // This test contract has no payable receiver.
        invoices.createInvoice(ID, AMOUNT, 0);
        uint256 payerBefore = PAYER.balance;
        VM.expectRevert(TermulInvoices.MerchantTransferFailed.selector);
        _pay(address(this), AMOUNT);
        require(PAYER.balance == payerBefore && address(invoices).balance == 0);
        require(invoices.getInvoice(address(this), ID).status == TermulInvoices.InvoiceStatus.Open);
    }

    function testReentrancyCannotPayAnotherInvoice() public {
        CallbackMerchant receiver = new CallbackMerchant(invoices, ID, OTHER_ID);
        receiver.open(AMOUNT);
        _pay(address(receiver), AMOUNT);
        require(receiver.callbackError() == TermulInvoices.ReentrantCall.selector);
        require(address(receiver).balance == AMOUNT && address(invoices).balance == 0);
        require(invoices.getInvoice(address(receiver), ID).status == TermulInvoices.InvoiceStatus.Paid);
        require(invoices.getInvoice(address(receiver), OTHER_ID).status == TermulInvoices.InvoiceStatus.Open);
    }

    function testUnsolicitedValueRevertsAndExistingBalanceDoesNotFundPayment() public {
        uint256 preexistingBalance = 1 ether;
        VM.deal(address(invoices), preexistingBalance);
        VM.prank(PAYER);
        (bool accepted,) = address(invoices).call{value: 1}("");
        require(!accepted);
        _create(MERCHANT, 0);
        _pay(MERCHANT, AMOUNT);
        require(MERCHANT.balance == AMOUNT && address(invoices).balance == preexistingBalance);
    }

    function _create(address merchant, uint64 expiry) private {
        VM.prank(merchant);
        invoices.createInvoice(ID, AMOUNT, expiry);
    }

    function _pay(address merchant, uint256 amount) private {
        VM.prank(PAYER);
        invoices.payInvoice{value: amount}(merchant, ID);
    }
}
