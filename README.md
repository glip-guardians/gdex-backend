# G-DEX Backend

Backend proxy server for the G-DEX application.
Solves CORS issues and secures the 0x API Key.

## Features
- 0x Swap API proxy
- Price preview endpoint
- Swap execution endpoint
- API key hidden (server-side)
- CORS enabled
- Works with G-DEX frontend

## API Routes

### GET /quote
Price preview

Query:
- sellToken
- buyToken
- sellAmount

### POST /swap
Get swap transaction data for MetaMask

Body:
- sellToken
- buyToken
- sellAmount
- taker (wallet address)

## Setup

