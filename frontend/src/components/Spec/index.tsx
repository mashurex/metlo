import React, { useRef, useState } from "react"
import NextLink from "next/link"
import { useRouter } from "next/router"
import {
  Heading,
  useColorModeValue,
  HStack,
  VStack,
  Text,
  InputGroup,
  Button,
  useToast,
  Box,
} from "@chakra-ui/react"
import { AiFillApi } from "@react-icons/all-files/ai/AiFillApi"
import { OpenApiSpec } from "@common/types"
import { deleteSpec, updateSpec } from "api/apiSpecs"
import { makeToast } from "utils"
import Editor from "@monaco-editor/react"

interface SpecPageProps {
  spec: OpenApiSpec
}

const SpecPage: React.FC<SpecPageProps> = React.memo(({ spec }) => {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const router = useRouter()
  const toast = useToast()
  const [fetching, setFetching] = useState<boolean>(false)
  const [deleting, setDeleting] = useState<boolean>(false)
  const handleClick = () => inputRef.current?.click()
  const handleSubmission = async (evt: React.ChangeEvent<HTMLInputElement>) => {
    setFetching(true)
    const file = evt.target.files[0]
    if (!file) {
      return
    }
    try {
      await updateSpec(spec.name, file)
      router.reload()
    } catch (err) {
      const errMessage = err.response.data?.message
      const title = errMessage
        ? `Upload Failed: ${errMessage}`
        : "Upload Failed..."
      const errors = err.response.data?.errors
      const description = errors ? errors.join(" ") : err.response.data
      toast(
        makeToast(
          {
            title,
            size: "xl",
            description,
            status: "error",
            duration: 1000000,
          },
          err.response?.status,
        ),
      )
    }
    setFetching(false)
  }
  const handleDelete = async (evt: React.MouseEvent<HTMLDivElement>) => {
    setDeleting(true)
    try {
      await deleteSpec(spec.name)
      router.push("/specs")
    } catch (err) {
      console.log(err)
      toast(
        makeToast(
          {
            title: `Couldn't Delete Spec ${spec.name}`,
            status: "error",
            description: "See the console for more details",
          },
          err.response?.status,
        ),
      )
    } finally {
      setDeleting(false)
    }
  }

  const headerColor = useColorModeValue(
    "rgb(179, 181, 185)",
    "rgb(91, 94, 109)",
  )

  return (
    <VStack h="full" w="full" alignItems="flex-start" spacing="10" pb="3px">
      <HStack justifyContent="space-between" w="full" alignItems="flex-end">
        <VStack alignItems="flex-start" pt="6">
          <NextLink href="/specs">
            <HStack color={headerColor} spacing="1" cursor="pointer">
              <AiFillApi />
              <Text fontWeight="semibold">API Specs</Text>
            </HStack>
          </NextLink>
          <Heading>{spec.name}</Heading>
        </VStack>

        <HStack marginLeft="auto">
          <InputGroup onClick={handleDelete}>
            <Button colorScheme="red" isLoading={deleting}>
              Delete Spec
            </Button>
          </InputGroup>
          <InputGroup onChange={handleSubmission} onClick={handleClick}>
            <input
              type="file"
              multiple={false}
              hidden
              ref={e => {
                inputRef.current = e
              }}
            />
            <Button colorScheme="blue" isLoading={fetching}>
              Update Spec
            </Button>
          </InputGroup>
        </HStack>
      </HStack>
      <Box h="full" w="full" borderWidth="1px">
        <Editor
          width="100%"
          defaultLanguage="yaml"
          value={spec.spec}
          options={{
            minimap: {
              enabled: false,
            },
            automaticLayout: true,
            readOnly: true,
            renderIndentGuides: false,
            scrollBeyondLastLine: false,
          }}
        />
      </Box>
    </VStack>
  )
})

export default SpecPage
