-- Belt and braces: the API validates amounts, the database refuses bad ones anyway.
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_amountPaise_positive" CHECK ("amountPaise" > 0);
