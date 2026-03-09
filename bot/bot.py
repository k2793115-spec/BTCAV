from bot.config import BotConfig
from bot.runner import BotRunner


def main():

    config = BotConfig()

    runner = BotRunner(config)

    runner.run()


if __name__ == "__main__":
    main()