# bot command responses - quick reference

## what you'll see when using the bot

### basic commands (no login needed)

**/start**
```
hey! evs2 cp2nus bot here.

/login <user> <pass> - log in (dm only)
/credits - check balance
/usage [days] - see daily spending (default: 7d)
/avgspend [days] - avg per day (default: 30d)
/predict - will you run out soon?
/rank - how you compare to neighbors
/topup - top up link
/meter - meter details
/remind - toggle daily alerts
/logout - forget credentials
/help - show commands
```

**/help**
```
dm me /login <user> <pass> to get started.
then use /credits to check balance.
/usage shows spending trends.
/rank compares you to neighbors.
/topup for the portal link.
/remind toggles daily alerts.
/logout clears your login.
```

**/topup**
```
top up here:
https://nus-utown.evs.com.sg/EVSWebPOS/

dashboard:
https://cp2nus.evs.com.sg/

note: may take a while to update
```

### authentication

**/login <username> <password>**

success:
```
logged in! try /credits
```

failure:
```
login failed
```

not in dm:
```
dm me for safety
```

invalid format:
```
usage: /login <user> <pass>
```

**/logout**
```
logged out. use /login to sign in again
```

### balance & credits (requires login)

**/credits**
```
💰 sgd 9.35
⚡ 287.4868 credits
updated: 2026-01-25 10:20:50
```

not logged in:
```
not logged in. dm me /login <user> <pass>
```

### meter info (requires login)

**/meter**
```
meter info:
meter_displayname: 10013290
meter_sn: 202206000350
```

### usage tracking (requires login)

**/usage** or **/usage 7**
```
balance: sgd 9.35
avg/day (7d): sgd 0.50
~18.7 days left

last 7 days:
2026-01-19: sgd 0.45
2026-01-20: sgd 0.52
2026-01-21: sgd 0.48
...
```

if running low:
```
balance: sgd 2.50
avg/day (7d): sgd 2.00
heads up: ~1.3 days left
```

if almost out:
```
balance: sgd 1.00
avg/day (7d): sgd 2.00
⚠️ running out soon (~0.5 days left)
```

**/avgspend** or **/avgspend 30**
```
avg/day (30d): sgd 0.45
```

**/predict**
```
balance: sgd 9.35
avg/day (7d): sgd 0.50
~18.7 days left
```

**/rank**
```
spent (7d): sgd 3.50
you use less than 75% of neighbors
updated: 2026-01-25 08:00:00
```

### reminders (requires login)

**/remind**

first use:
```
reminders on
```

second use:
```
reminders off
```

daily reminder (sent at 9am if enabled):
```
heads up: ~1.2 days left
balance: sgd 2.40
top up: https://nus-utown.evs.com.sg/EVSWebPOS/
```

### error responses

**not authorized:**
```
not authorized
```

**not logged in:**
```
not logged in. dm me /login <user> <pass>
```

**api errors:**
```
couldn't fetch balance
couldn't fetch usage
couldn't fetch rank
couldn't fetch meter info
couldn't calculate avg spend
couldn't predict run-out
```

**general error:**
```
oops, something went wrong. try again?
```

## tips

1. always use `/login` in a **private dm** with the bot
2. responses are always **lowercase and casual**
3. emojis used: 💰 (money), ⚡ (credits), ⚠️ (warning)
4. error messages are **friendly** without technical details
5. daily reminders sent at **9am** if enabled
