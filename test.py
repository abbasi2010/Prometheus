from brain import send

if __name__ == "__main__":
    while True:
        try:
            reply = send(input("\n> "))
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if reply is not None:
            print(reply)
