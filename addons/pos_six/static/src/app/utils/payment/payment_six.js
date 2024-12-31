/* global timapi */

import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { escape } from "@web/core/utils/strings";
import { register_payment_method } from "@point_of_sale/app/services/pos_store";

window.onTimApiReady = function () {};
window.onTimApiPublishLogRecord = function (record) {
    // Log only warning or errors
    if (record.matchesLevel(timapi.LogRecord.LogLevel.warning)) {
        timapi.log(String(record));
    }
};

export class PaymentSix extends PaymentInterface {
    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    setup() {
        super.setup(...arguments);
        this.enableReversals();

        var terminal_ip = this.payment_method_id.six_terminal_ip;
        var instanced_payment_method = this.pos.models["pos.payment.method"].find(function (
            payment_method
        ) {
            return (
                payment_method.use_payment_terminal === "six" &&
                payment_method.six_terminal_ip === terminal_ip &&
                payment_method.payment_terminal
            );
        });
        if (instanced_payment_method !== undefined) {
            var payment_terminal = instanced_payment_method.payment_terminal;
            this.terminal = payment_terminal.terminal;
            this.terminalListener = payment_terminal.terminalListener;
            return;
        }

        var settings = new timapi.TerminalSettings();
        settings.connectionMode = timapi.constants.ConnectionMode.onFixIp;
        settings.connectionIPString = this.payment_method_id.six_terminal_ip;
        settings.connectionIPPort = "80";
        settings.integratorId = "175d97a0-2a88-4413-b920-e90037b582ac";
        settings.dcc = false;

        this.terminal = new timapi.Terminal(settings);
        this.terminal.setPosId(this.pos.session.name);
        this.terminal.setUserId(this.pos.user.id);

        this.terminalListener = new timapi.DefaultTerminalListener();
        this.terminalListener.transactionCompleted = this._onTransactionComplete.bind(this);
        this.terminalListener.balanceCompleted = this._onBalanceComplete.bind(this);
        this.terminal.addListener(this.terminalListener);

        var recipients = [
            timapi.constants.Recipient.merchant,
            timapi.constants.Recipient.cardholder,
        ];
        var options = [];
        recipients.forEach((recipient) => {
            var option = new timapi.PrintOption(
                recipient,
                timapi.constants.PrintFormat.normal,
                45,
                [
                    timapi.constants.PrintFlag.suppressHeader,
                    timapi.constants.PrintFlag.suppressEcrInfo,
                ]
            );
            options.push(option);
        });
        this.terminal.setPrintOptions(options);
    }

    /**
     * @override
     */
    sendPaymentCancel() {
        super.sendPaymentCancel(...arguments);
        this.terminal.cancel();
        return Promise.resolve();
    }

    /**
     * @override
     */
    sendPaymentRequest() {
        super.sendPaymentRequest(...arguments);
        this.pos.getOrder().getSelectedPaymentline().setPaymentStatus("waitingCard");
        return this._sendTransaction(timapi.constants.TransactionType.purchase);
    }

    /**
     * @override
     */
    sendPaymentReversal() {
        super.sendPaymentReversal(...arguments);
        this.pos.getOrder().getSelectedPaymentline().setPaymentStatus("reversing");
        return this._sendTransaction(timapi.constants.TransactionType.reversal);
    }

    sendBalance() {
        this.terminal.balanceAsync();
    }

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    _onTransactionComplete(event, data) {
        timapi.DefaultTerminalListener.prototype.transactionCompleted(event, data);

        if (event.exception) {
            if (event.exception.resultCode !== timapi.constants.ResultCode.apiCancelEcr) {
                this.env.services.dialog.add(AlertDialog, {
                    title: _t("Transaction was not processed correctly"),
                    body: event.exception.errorText,
                });
            }

            this.transactionResolve();
        } else {
            if (data.printData) {
                this._printReceipts(data.printData.receipts);
            }

            // Store Transaction Data
            var transactionData = new timapi.TransactionData();
            transactionData.transSeq = data.transactionInformation.transSeq;
            this.terminal.setTransactionData(transactionData);

            this.transactionResolve(true);
        }
    }

    _onBalanceComplete(event, data) {
        if (event.exception) {
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Balance Failed"),
                body: _t("The balance operation failed."),
            });
        } else {
            this._printReceipts(data.printData.receipts);
        }
    }

    _printReceipts(receipts) {
        Object.values(receipts || {}).forEach((receipt) => {
            if (
                receipt.recipient === timapi.constants.Recipient.merchant &&
                this.pos.hardwareProxy.printer
            ) {
                this.pos.hardwareProxy.printer.printReceipt(
                    "<div class='pos-receipt'><div class='pos-payment-terminal-receipt'>" +
                        escape(receipt.value).replace(/\n/g, "<br />") +
                        "</div></div>"
                );
            } else if (receipt.recipient === timapi.constants.Recipient.cardholder) {
                this.pos.getOrder().getSelectedPaymentline().setReceiptInfo(receipt.value);
            }
        });
    }

    _sendTransaction(transactionType) {
        var amount = new timapi.Amount(
            Math.round(
                this.pos.getOrder().getSelectedPaymentline().amount / this.pos.currency.rounding
            ),
            timapi.constants.Currency[this.pos.currency.name],
            this.pos.currency.decimal_places
        );

        return new Promise((resolve) => {
            this.transactionResolve = resolve;
            this.terminal.transactionAsync(transactionType, amount);
        });
    }
}

register_payment_method("six", PaymentSix);
