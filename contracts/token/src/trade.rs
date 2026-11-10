//! Buying and selling on the curve (SPEC §2) and the meeting's
//! buyback-and-burn (§5.3).

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise};

use crate::curve::bps_floor;
use crate::*;

impl Chair {
    /// Buyback for `bps` of supply: `(tokens, near, fund_limited)`. The
    /// target is `floor(supply · bps / 10_000)`; if the fund cannot pay for
    /// it, the largest amount the fund can buy.
    pub(crate) fn plan_buyback(&self, bps: u16) -> (u128, u128, bool) {
        if bps == 0 || self.supply == 0 {
            return (0, 0, false);
        }
        let target = bps_floor(self.supply, bps as u128);
        let c = self.curve();
        match c.buy_cost(self.sold, target) {
            Some(cost) if cost <= self.buyback_fund => (target, cost, false),
            _ => {
                let (tokens, cost) = c.max_buy(self.sold, self.buyback_fund);
                (tokens, cost, true)
            }
        }
    }

    /// Buys `tokens` on the curve with fund NEAR and burns them at once.
    /// Supply is unchanged; `s` and the reserve grow, so the reserve now
    /// over-collateralises the supply and the floor `p(burned)` rises.
    pub(crate) fn execute_buyback(&mut self, tokens: u128, near: u128) {
        if tokens == 0 {
            return;
        }
        self.buyback_fund -= near;
        self.reserve += near;
        self.sold += tokens;
        self.burned += tokens;
        self.stats.buyback_tokens_burned.0 += tokens;
        self.stats.buyback_near_spent.0 += near;
    }
}

#[near]
impl Chair {
    /// Buys CHAIR with the attached NEAR: the most tokens whose curve cost
    /// plus tax fits the deposit; the rest is refunded. An unregistered
    /// buyer is registered first out of the deposit (0.025 NEAR).
    #[payable]
    pub fn buy(&mut self, min_out: U128) -> BuyResult {
        let buyer = env::predecessor_account_id();
        let mut deposit = env::attached_deposit().as_yoctonear();
        if !self.accounts.contains_key(&buyer) {
            require!(
                deposit > STORAGE_DEPOSIT,
                "attach 0.025 NEAR for registration plus the purchase"
            );
            self.register(&buyer);
            deposit -= STORAGE_DEPOSIT;
        }
        let (tokens, cost, tax) = self
            .curve()
            .quote_buy(self.sold, deposit, self.levers.tax_bps);
        require!(tokens > 0, "deposit buys nothing");
        require!(tokens >= min_out.0, "slippage: fewer tokens than min_out");
        let refund = deposit - cost - tax;

        self.reserve += cost;
        self.sold += tokens;
        self.supply += tokens;
        self.internal_deposit(&buyer, tokens);
        self.collect_tax(tax);
        self.record_volume(cost, 0);
        self.stats.buys += 1;
        self.stats.volume_buy.0 += cost;

        events::ft_mint(&buyer, tokens, Some("curve buy"));
        events::emit(
            "buy",
            &json!({
                "account_id": buyer,
                "tokens": U128(tokens),
                "cost": U128(cost),
                "tax": U128(tax),
                "price": U128(self.curve().price(self.sold)),
            }),
        );
        if refund > 0 {
            Promise::new(buyer)
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        BuyResult {
            tokens: U128(tokens),
            cost: U128(cost),
            tax: U128(tax),
            refund: U128(refund),
        }
    }

    /// Sells `amount` back to the curve for `R(s) − R(s−amount)` minus tax.
    /// Requires 1 yoctoNEAR (like `ft_transfer`) so function-call keys
    /// cannot dump a holder's tokens.
    #[payable]
    pub fn sell(&mut self, amount: U128, min_near_out: U128) -> SellResult {
        assert_one_yocto();
        let seller = env::predecessor_account_id();
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        self.internal_withdraw(&seller, amount);
        let (gross, tax, net) = self
            .curve()
            .quote_sell(self.sold, amount, self.levers.tax_bps);
        require!(net >= min_near_out.0, "slippage: less NEAR than min_near_out");

        self.reserve -= gross;
        self.sold -= amount;
        self.supply -= amount;
        self.collect_tax(tax);
        self.record_volume(0, gross);
        self.stats.sells += 1;
        self.stats.volume_sell.0 += gross;

        events::ft_burn(&seller, amount, Some("curve sell"));
        events::emit(
            "sell",
            &json!({
                "account_id": seller,
                "tokens": U128(amount),
                "gross": U128(gross),
                "tax": U128(tax),
                "near_out": U128(net),
                "price": U128(self.curve().price(self.sold)),
            }),
        );
        if net > 0 {
            Promise::new(seller)
                .transfer(NearToken::from_yoctonear(net))
                .detach();
        }
        SellResult {
            gross: U128(gross),
            tax: U128(tax),
            near_out: U128(net),
        }
    }

    /// What `buy` would do with `near_in` attached (by `account_id`, if
    /// given: an unregistered account pays the storage deposit first).
    pub fn quote_buy(&self, near_in: U128, account_id: Option<AccountId>) -> BuyQuote {
        let mut deposit = near_in.0;
        let storage = match account_id {
            Some(a) if !self.accounts.contains_key(&a) => STORAGE_DEPOSIT.min(deposit),
            _ => 0,
        };
        deposit -= storage;
        let c = self.curve();
        let (tokens, cost, tax) = c.quote_buy(self.sold, deposit, self.levers.tax_bps);
        BuyQuote {
            tokens: U128(tokens),
            cost: U128(cost),
            tax: U128(tax),
            storage: U128(storage),
            refund: U128(deposit - cost - tax),
            price_after: U128(c.price(self.sold + tokens)),
        }
    }

    /// What `sell(amount)` would pay now.
    pub fn quote_sell(&self, amount: U128) -> SellQuote {
        require!(amount.0 <= self.supply, "amount exceeds supply");
        let c = self.curve();
        let (gross, tax, net) = c.quote_sell(self.sold, amount.0, self.levers.tax_bps);
        SellQuote {
            gross: U128(gross),
            tax: U128(tax),
            near_out: U128(net),
            price_after: U128(c.price(self.sold - amount.0)),
        }
    }
}
