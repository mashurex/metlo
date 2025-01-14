from datetime import timedelta
from uuid import uuid4
import json

from producers.utils import get_auth_header, get_meta, JSON_HEADER
from producers.base import BaseProducer


class PaymentProcessorUserProducer(BaseProducer):

    avg_emit_delta = timedelta(minutes=5)

    def get_data_point(self, time) -> dict:
        resp_body = {
            "user_uuid": str(uuid4()),
            "success": True,
            "msg": "Created a new user...",
        }
        req_body = {
            "name": self.fake.first_name(),
            "email": self.fake.free_email(),
            "address": self.fake.address(),
            "phoneNumber": self.fake.phone_number(),
        }
        return {
            "request": {
                "url": {
                    "host": "test-payment-processor.metlo.com",
                    "path": "/user",
                    "parameters": []
                },
                "headers": [get_auth_header()],
                "method": "POST",
                "body": json.dumps(req_body),
            },
            "response": {
                "status": 200,
                "headers": [JSON_HEADER],
                "body": json.dumps(resp_body),
            },
            "meta": get_meta(),
        }
