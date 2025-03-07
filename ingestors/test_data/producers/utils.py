from uuid import uuid4
from random import choice
from faker import Faker
from faker.providers import internet

fake = Faker()
fake.add_provider(internet)


JSON_HEADER = {
    "name": "content-type",
    "value": "application/json; charset=utf-8",
}


def get_meta():
    return {
        "environment": "production",
        "incoming": True,
        "source": fake.ipv4(),
        "sourcePort": choice(range(10000, 20000)),
        "destination": "76.47.25.189",
        "destinationPort": 443,
    }


def get_auth_header():
    return {
        "name": "X-API-KEY",
        "value": str(uuid4()),
    }
