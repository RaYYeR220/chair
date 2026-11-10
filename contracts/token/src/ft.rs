//! NEP-141 (core), NEP-145 (storage, fixed 0.025 NEAR per account) and
//! NEP-148 (metadata). Locked tokens never move: transfers, sells and fees
//! draw only on `balance − locked`.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, GasWeight, NearToken, Promise,
    PromiseOrValue,
};

use crate::*;

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23101010'/%3E%3Cpath d='M10 5h12v13H10zM7 18h18v3H7zM9 21h2.5v7H9zM20.5 21H23v7h-2.5z' fill='%23f2c14e'/%3E%3C/svg%3E";

impl Chair {
    /// Tokens of `a` still under an unexpired lock.
    pub(crate) fn locked_amount(a: &Account, now: u64) -> u128 {
        a.locks
            .iter()
            .filter(|l| l.unlock_at > now)
            .map(|l| l.amount)
            .sum()
    }

    /// Takes `amount` from `id`'s unlocked balance (expired locks are
    /// released first, settling their rewards).
    pub(crate) fn internal_withdraw(&mut self, id: &AccountId, amount: u128) {
        let now = env::block_timestamp();
        let mut a = self.account_or_panic(id);
        self.release_expired(&mut a, now);
        let free = a.balance - Self::locked_amount(&a, now);
        require!(amount <= free, "not enough unlocked CHAIR");
        a.balance -= amount;
        self.accounts.insert(id.clone(), a);
    }

    pub(crate) fn internal_deposit(&mut self, id: &AccountId, amount: u128) {
        let a = self
            .accounts
            .get_mut(id)
            .unwrap_or_else(|| env::panic_str(&format!("{id} is not registered")));
        a.balance += amount;
    }

    fn internal_transfer(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        amount: u128,
        memo: Option<&str>,
    ) {
        require!(sender != receiver, "sender and receiver must differ");
        require!(amount > 0, "amount must be positive");
        require!(
            self.accounts.contains_key(receiver),
            format!("{receiver} is not registered")
        );
        self.internal_withdraw(sender, amount);
        self.internal_deposit(receiver, amount);
        events::ft_transfer(sender, receiver, amount, memo);
    }

    /// Removes tokens from existence. `s` is unchanged, so the reserve
    /// over-collateralises the remaining supply (SPEC §5.3).
    pub(crate) fn burn_supply(&mut self, amount: u128) {
        self.supply -= amount;
        self.burned += amount;
    }
}

#[near]
impl Chair {
    // ------------------------------------------------------------ NEP-141

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0, memo.as_deref());
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        require!(
            env::prepaid_gas() > GAS_FOR_FT_TRANSFER_CALL,
            "more gas is required"
        );
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0, memo.as_deref());
        let args = json!({ "sender_id": sender, "amount": amount, "msg": msg })
            .to_string()
            .into_bytes();
        Promise::new(receiver_id.clone())
            .function_call_weight(
                "ft_on_transfer",
                args,
                NearToken::from_yoctonear(0),
                env::prepaid_gas().saturating_sub(GAS_FOR_FT_TRANSFER_CALL),
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    /// Returns the amount the receiver kept. The unused part goes back to
    /// the sender out of the receiver's unlocked balance (burned if the
    /// sender has unregistered meanwhile).
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let amount = amount.0;
        let unused = match env::promise_result_checked(0, 128) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .map(|u| u.0.min(amount))
                .unwrap_or(amount),
            Err(_) => amount,
        };
        if unused == 0 {
            return U128(amount);
        }
        let now = env::block_timestamp();
        let refund = match self.accounts.get(&receiver_id).cloned() {
            Some(mut r) => {
                self.release_expired(&mut r, now);
                let free = r.balance - Self::locked_amount(&r, now);
                let refund = unused.min(free);
                r.balance -= refund;
                self.accounts.insert(receiver_id.clone(), r);
                refund
            }
            None => 0,
        };
        if refund > 0 {
            if self.accounts.contains_key(&sender_id) {
                self.internal_deposit(&sender_id, refund);
                events::ft_transfer(&receiver_id, &sender_id, refund, Some("refund"));
            } else {
                self.burn_supply(refund);
                events::ft_burn(&receiver_id, refund, Some("refund to unregistered sender"));
            }
        }
        U128(amount - refund)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.accounts.get(&account_id).map_or(0, |a| a.balance))
    }

    // ------------------------------------------------------------ NEP-148

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".to_string(),
            name: NAME.to_string(),
            symbol: SYMBOL.to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }

    // ------------------------------------------------------------ NEP-145

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only; // fixed-size storage: extra deposit is always refunded
        let amount = env::attached_deposit().as_yoctonear();
        let id = account_id.unwrap_or_else(env::predecessor_account_id);
        let refund = if self.accounts.contains_key(&id) {
            amount
        } else {
            require!(
                amount >= STORAGE_DEPOSIT,
                "attach at least 0.025 NEAR to register"
            );
            self.register(&id);
            amount - STORAGE_DEPOSIT
        };
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        StorageBalance {
            total: U128(STORAGE_DEPOSIT),
            available: U128(0),
        }
    }

    /// Fixed storage: nothing is ever available to withdraw.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        require!(self.accounts.contains_key(&id), "not registered");
        require!(
            amount.is_none_or(|a| a.0 == 0),
            "no storage balance is available"
        );
        StorageBalance {
            total: U128(STORAGE_DEPOSIT),
            available: U128(0),
        }
    }

    /// Unregisters and returns the 0.025 NEAR. Locks must be released and
    /// rewards claimed first; a remaining balance is burned only with `force`.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let Some(a) = self.accounts.get(&id).cloned() else {
            return false;
        };
        require!(a.locks.is_empty(), "unlock (and wait for) every lock first");
        require!(a.claimable == 0, "claim locker rewards first");
        if a.balance > 0 {
            require!(force == Some(true), "balance is not empty; pass force to burn it");
            self.burn_supply(a.balance);
            events::ft_burn(&id, a.balance, Some("force unregister"));
        }
        self.accounts.remove(&id);
        self.holders -= 1;
        Promise::new(id)
            .transfer(NearToken::from_yoctonear(STORAGE_DEPOSIT))
            .detach();
        true
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_DEPOSIT),
            max: Some(U128(STORAGE_DEPOSIT)),
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.contains_key(&account_id).then_some(StorageBalance {
            total: U128(STORAGE_DEPOSIT),
            available: U128(0),
        })
    }
}
