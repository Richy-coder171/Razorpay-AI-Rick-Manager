# Razorpay AI Risk Manager

> **This README is retired.** The workspace-level documentation now lives in
> [`../README.md`](../README.md) (one level up), which reflects the current v2
> architecture, API reference, evaluation numbers, known issues, and run
> instructions.
>
> The workspace contains two deliberate implementations of the same
> bounded-action contract: this TypeScript full-stack app, and the stdlib-only
> Python orchestration package at [`../risk_manager/`](../risk_manager) that
> demonstrates the contract with zero dependencies.
>
> Everything below this line is the historical v1 buildathon write-up and no
> longer matches the code. It is kept for provenance only.

---

A production-grade full-stack application for the **Razorpay AI Buildathon 2026 — Track 02: AI Risk Manager**.

## Problem

Merchants lose money when fraud, abuse, returns, and chargebacks are detected too late or handled inconsistently. This system provides real-time risk detection with measurable precision and recall.

## Solution

An AI-powered Risk Manager that detects and responds to merchant losses from:
- **Fraud spikes** (primary module)
- **Return/COD risk**
- **Abuse rings**
- **Chargebacks**

## Core Principle

> AI recommends. Deterministic code controls. Humans handle uncertainty.

The LLM never directly controls money, payment state, or irreversible actions.
