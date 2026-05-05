# Sudoku Website — Project Plan

## Overview

Build a web-based Sudoku platform featuring:

* Daily Sudoku challenges (same puzzle for all users per day)
* Difficulty levels (Easy → Expert)
* A pool of pre-generated puzzles available anytime
* Clean, responsive gameplay interface

---

# Phase 0 — Scope Definition

## Goals

* Web application only
* Single-player experience
* No authentication (initially)

## Non-goals (for now)

* Multiplayer
* Real-time competition
* Mobile app

---

# Phase 1 — Core Engine

## 1. Board Representation

* Use array of length 81 OR 9×9 grid
* Empty cells represented by `0`

## 2. Validator

Functions:

* Validate row
* Validate column
* Validate 3×3 box
* Validate single move

## 3. Solver

* Backtracking algorithm
* Must support:

  * Solving puzzle
  * Counting number of solutions (stop at 2)

## 4. Full Grid Generator

* Generate complete valid Sudoku grid
* Use randomized backtracking

## 5. Puzzle Generator

Steps:

1. Start from solved grid
2. Remove cells one by one
3. After each removal:

   * Check uniqueness using solver
   * Revert if multiple solutions

## 6. Difficulty System

Initial (simple):

* Based on clue count

| Difficulty | Clues |
| ---------- | ----- |
| Easy       | 36–45 |
| Medium     | 30–35 |
| Hard       | 25–29 |
| Expert     | <25   |

---

# Phase 2 — Backend

## 1. Setup

* REST API

## 2. Modules

* validator
* solver
* generator
* difficulty

## 3. Database Schema

Table: `puzzles`

* id
* puzzle (string)
* solution (string)
* difficulty
* is_daily (boolean)
* date (nullable)

## 4. Pre-generation Script

Generate and store:

* 200 Easy
* 200 Medium
* 200 Hard
* 100 Expert

## 5. API Endpoints

### Get random puzzle

GET /puzzle/random?difficulty=

### Get daily puzzle

GET /puzzle/daily

### Validate solution (optional)

POST /puzzle/validate

---

# Phase 3 — Frontend

## 1. Core UI

* 9×9 grid
* Highlight selected cell
* Distinguish fixed vs editable cells

## 2. State Management

* Current board
* Initial board
* Selected cell
* Timer
* Mistakes

## 3. Input

* Keyboard (1–9, delete)
* On-screen number pad (mobile)

---

# Phase 4 — Core Features

## MVP

* Load puzzle from backend
* Render grid
* Enter numbers
* Prevent editing fixed cells
* Basic validation

## UX Features

* Timer
* Reset button
* New puzzle button
* Difficulty selector

---

# Phase 5 — Daily Challenge

## Implementation

* Pre-assign puzzles to dates
* Store in database

## Features

* Daily puzzle page
* Show completion state
* Reset daily at midnight

---

# Phase 6 — Enhanced Gameplay

* Notes (pencil marks)
* Highlight conflicts
* Highlight row/column/box
* Mistake counter

---

# Phase 7 — Advanced Features

* Hint system (solver-assisted)
* Undo / Redo
* Auto-check toggle
* Save progress (local storage)

---

# Phase 8 — Optional Extensions

* User accounts
* Leaderboards
* Streak tracking

---

# Performance Strategy

* Do NOT generate puzzles on request
* Pre-generate all puzzles
* Cache daily puzzle

---

# Testing Checklist

* Solver correctness
* Unique solution guarantee
* No invalid placements
* UI input correctness

---

# Deployment

## Backend

* Deploy API server

## Frontend

* Deploy static frontend

---

# Development Order (Strict)

1. Solver
2. Solution counter
3. Generator
4. Pre-generation script
5. Database
6. API
7. Frontend grid
8. Input system
9. API integration
10. Features incrementally

---

# Notes

* Focus on correctness first, optimization later
* Difficulty system can be improved over time
* UI polish comes after core gameplay works
