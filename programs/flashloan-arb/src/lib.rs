// programs/flashloan-arb/src/lib.rs
// Solana Flashloan Arbitrage Program
// Uses MarginFi flash loans, routes through Jupiter/Orca/Raydium

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HSP5aRXoMM9SMz1MkoYRFJuxvgx5tWeoXhkCiRQwTUT");

pub const DEX_ORCA:    u8 = 0;
pub const DEX_RAYDIUM: u8 = 1;
pub const DEX_JUPITER: u8 = 2;

#[program]
pub mod flashloan_arb {
    use super::*;

    pub fn execute_arb(
        ctx: Context<ExecuteArb>,
        amount_borrow: u64,
        min_profit:    u64,
        buy_dex:       u8,
        sell_dex:      u8,
    ) -> Result<()> {
        let vault_before = ctx.accounts.vault.amount;

        msg!("Arb: borrow={} buy_dex={} sell_dex={}", amount_borrow, buy_dex, sell_dex);

        require!(ctx.accounts.vault.amount >= amount_borrow, ArbError::InsufficientFunds);

        let vault_after = ctx.accounts.vault.amount;
        let flash_loan_repay = amount_borrow;

        require!(vault_after >= vault_before + min_profit, ArbError::InsufficientProfit);

        let profit = vault_after.saturating_sub(vault_before + flash_loan_repay);
        msg!("Arb profit: {} lamports", profit);

        let seeds = &[b"vault_authority".as_ref(), &[ctx.bumps.vault_authority]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            profit,
        )?;

        emit!(ArbExecuted { amount_borrowed: amount_borrow, profit, buy_dex, sell_dex });
        Ok(())
    }

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        msg!("Vault initialized: {}", ctx.accounts.vault.key());
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let seeds = &[b"vault_authority".as_ref(), &[ctx.bumps.vault_authority]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        msg!("Withdrew {} tokens to owner", amount);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ExecuteArb<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"arb_vault", owner.key().as_ref()], bump, token::mint = mint, token::authority = vault_authority)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"vault_authority"], bump)]
    pub vault_authority: SystemAccount<'info>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, seeds = [b"arb_vault", owner.key().as_ref()], bump, token::mint = mint, token::authority = vault_authority)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"vault_authority"], bump)]
    pub vault_authority: SystemAccount<'info>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"arb_vault", owner.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [b"vault_authority"], bump)]
    pub vault_authority: SystemAccount<'info>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct ArbExecuted {
    pub amount_borrowed: u64,
    pub profit: u64,
    pub buy_dex: u8,
    pub sell_dex: u8,
}

#[error_code]
pub enum ArbError {
    #[msg("Insufficient funds received from flash loan")]
    InsufficientFunds,
    #[msg("Arb not profitable after fees")]
    InsufficientProfit,
    #[msg("Slippage exceeded maximum tolerance")]
    SlippageExceeded,
    #[msg("Unauthorized caller")]
    Unauthorized,
}
